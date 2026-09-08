import { exec, execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config";
import { AppError } from "../errors";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function updateErrorDetail(error: unknown): string | undefined {
  const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr
    : undefined;
  const raw = stderr?.trim() || (error instanceof Error ? error.message.trim() : "");
  if (!raw) return undefined;

  // Update commands never receive credentials as arguments, but keep diagnostics safe if a tool echoes environment values.
  return raw
    .replace(/\b(token|password|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export interface UpdateStatus {
  enabled: boolean;
  state: "idle" | "checking" | "available" | "updating" | "restart-required" | "failed" | "unavailable";
  currentVersion: string;
  latestVersion?: string;
  buildVersion?: string;
  message?: string;
  checkedAt?: string;
  tokenConfigured?: boolean;
  requiresToken?: boolean;
}

export interface ServerVersion {
  commit: string;
  shortCommit: string;
  buildCommit: string;
  buildShortCommit: string;
  runningCommit: string;
  runningShortCommit: string;
  bootId: string;
  branch: string;
  startedAt: string;
}

export interface UpdateServiceDependencies {
  runGit?: (args: string[]) => Promise<string>;
  runNpm?: (args: string[]) => Promise<void>;
  scheduleRestart?: () => void;
  runningCommit?: string;
}

interface TrackedChange {
  status: string;
  path: string;
}

function parseTrackedChanges(output: string): TrackedChange[] {
  const changes: TrackedChange[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.startsWith("# ") || line.startsWith("? ") || line.startsWith("! ")) continue;
    const fields = line.split(" ");
    if (fields[0] === "1" && fields.length >= 9) {
      changes.push({ status: fields[1] || "??", path: fields.slice(8).join(" ") });
      continue;
    }
    if (fields[0] === "2" && fields.length >= 10) {
      changes.push({ status: fields[1] || "??", path: fields.slice(9).join(" ") });
      continue;
    }
    if (fields[0] === "u" && fields.length >= 11) {
      changes.push({ status: fields[1] || "UU", path: fields.slice(10).join(" ") });
      continue;
    }
    // An unknown tracked status record is still a reason to fail closed. Keeping
    // the bounded record in the diagnostic is safer than pulling over it.
    changes.push({ status: "??", path: line });
  }
  return changes;
}

function trackedChangesDetail(changes: TrackedChange[]): string {
  const visible = changes.slice(0, 20).map((change) => `${change.status} ${change.path}`);
  if (changes.length > visible.length) visible.push(`... and ${changes.length - visible.length} more`);
  return visible.join("; ");
}

/** npm may rewrite these on a host with a different npm version; they are safe to discard before pull. */
const AUTO_RESTORABLE_BEFORE_PULL = new Set(["package-lock.json", "package.json"]);

function isAutoRestorableBeforePull(change: TrackedChange): boolean {
  const normalized = change.path.replace(/\\/g, "/");
  return AUTO_RESTORABLE_BEFORE_PULL.has(normalized);
}

export class UpdateService {
  private readonly config: AppConfig;
  private readonly dependencies: UpdateServiceDependencies;
  private running = false;
  private restartScheduled = false;
  private readonly startedAt = new Date().toISOString();
  private readonly buildMetadataPath: string;
  private readonly runningCommit: string;
  private readonly bootId = randomUUID();

  constructor(config: AppConfig, dependencies: UpdateServiceDependencies = {}) {
    this.config = config;
    this.dependencies = dependencies;
    this.buildMetadataPath = path.join(config.projectRoot, "apps", "web", "dist", "build-meta.json");
    if (dependencies.runningCommit !== undefined) {
      this.runningCommit = dependencies.runningCommit;
      return;
    }
    try {
      this.runningCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: config.projectRoot, timeout: 10_000, windowsHide: true, encoding: "utf8" }).trim() || "unknown";
    } catch {
      this.runningCommit = "unknown";
    }
  }

  private base(state: UpdateStatus["state"] = "idle"): UpdateStatus {
    return { enabled: this.config.updateEnabled === true, state, currentVersion: "unknown", tokenConfigured: Boolean(this.config.updateToken), requiresToken: this.config.authEnabled !== true };
  }

  private async git(args: string[]): Promise<string> {
    if (this.dependencies.runGit) return (await this.dependencies.runGit(args)).trim();
    const result = await execFileAsync("git", args, { cwd: this.config.projectRoot ?? process.cwd(), timeout: 120_000, windowsHide: true });
    return result.stdout.trim();
  }

  private async npm(args: string[]): Promise<void> {
    if (this.dependencies.runNpm) return this.dependencies.runNpm(args);
    const cwd = this.config.projectRoot ?? process.cwd();
    const timeout = 30 * 60_000;
    if (process.platform === "win32") {
      // npm.cmd is a Windows command script, not a native executable. Node's execFile
      // can report `spawn EINVAL` for it because execFile does not use a shell.
      await execAsync(["npm.cmd", ...args].join(" "), { cwd, timeout, windowsHide: true });
      return;
    }
    await execFileAsync("npm", args, { cwd, timeout, windowsHide: true });
  }

  private async currentVersion(): Promise<string> {
    try { return await this.git(["rev-parse", "--short", "HEAD"]); } catch { return "unknown"; }
  }

  private async currentBuildVersion(): Promise<string> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.buildMetadataPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null && "commit" in parsed && typeof parsed.commit === "string" && parsed.commit.length > 0) {
        return parsed.commit;
      }
    } catch {
      // A missing marker means the compiled web bundle predates build identity support.
    }
    return "unknown";
  }

  private commitsMatch(left: string, right: string): boolean {
    return left !== "unknown" && right !== "unknown" && (left === right || left.startsWith(right) || right.startsWith(left));
  }

  private async assertTrackedTreeClean(phase: "before pull" | "after dependency installation" | "after build"): Promise<void> {
    let output: string;
    try {
      // Porcelain v2 gives stable status fields. Deliberately exclude untracked
      // and ignored files so .env, data, logs, dist, node_modules and WinSW
      // runtime artifacts cannot block or be modified by the updater.
      output = await this.git(["status", "--porcelain=v2", "--untracked-files=no", "--ignore-submodules=none"]);
    } catch (error) {
      const detail = updateErrorDetail(error);
      throw new AppError(
        "UPDATE_FAILED",
        `Unable to verify that the Git checkout is clean ${phase}; the update was stopped without changing files${detail ? `: ${detail}` : "."}`,
        502,
      );
    }
    let changes = parseTrackedChanges(output);
    if (changes.length === 0) return;

    if (phase === "before pull" && changes.every(isAutoRestorableBeforePull)) {
      const paths = [...new Set(changes.map((change) => change.path.replace(/\\/g, "/")))];
      try {
        // Discard host-local npm lockfile drift so a previous `npm install` cannot
        // permanently block remote updates. Source edits still fail closed below.
        await this.git(["restore", "--worktree", "--source=HEAD", "--", ...paths]);
        await this.git(["restore", "--staged", "--", ...paths]);
        output = await this.git(["status", "--porcelain=v2", "--untracked-files=no", "--ignore-submodules=none"]);
        changes = parseTrackedChanges(output);
        if (changes.length === 0) return;
      } catch (error) {
        const detail = updateErrorDetail(error);
        throw new AppError(
          "UPDATE_FAILED",
          `Update blocked before pulling because package-lock drift could not be restored automatically (${trackedChangesDetail(changes)})${detail ? `: ${detail}` : "."}`,
          409,
        );
      }
    }

    const action = phase === "before pull" ? "before pulling" : "before restarting";
    throw new AppError(
      "UPDATE_FAILED",
      `Update blocked ${action} because tracked or staged Git changes are present (${trackedChangesDetail(changes)}). ` +
        "Inspect them manually with `git status --short --untracked-files=no`, `git diff`, and `git diff --cached`. " +
        "After reviewing, either commit the intentional changes or restore only the chosen paths with `git restore --worktree -- <path>` and/or `git restore --staged -- <path>`, then retry. No files were restored automatically.",
      409,
    );
  }

  async version(): Promise<ServerVersion> {
    const [commit, branch, buildCommit] = await Promise.all([
      this.git(["rev-parse", "HEAD"]).catch(() => "unknown"),
      this.git(["branch", "--show-current"]).catch(() => "unknown"),
      this.currentBuildVersion(),
    ]);
    return {
      commit,
      shortCommit: commit === "unknown" ? "unknown" : commit.slice(0, 7),
      buildCommit,
      buildShortCommit: buildCommit === "unknown" ? "unknown" : buildCommit.slice(0, 7),
      runningCommit: this.runningCommit,
      runningShortCommit: this.runningCommit === "unknown" ? "unknown" : this.runningCommit.slice(0, 7),
      bootId: this.bootId,
      branch: branch || "unknown",
      startedAt: this.startedAt,
    };
  }

  private requestRestart(): void {
    if (this.config.nodeEnv !== "production") return;

    this.restartScheduled = true;
    if (this.dependencies.scheduleRestart) {
      this.dependencies.scheduleRestart();
      return;
    }
    const winSwPath = path.join(this.config.projectRoot, "scripts", "windows", "LocalAIRemote.exe");
    if (process.platform === "win32" && existsSync(winSwPath)) {
      try {
        // WinSW's self-restart command creates a separate process group so it survives
        // the service stop that terminates this Node process.
        const child = spawn(winSwPath, ["restart!"], {
          cwd: path.dirname(winSwPath),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", () => {
          // The exit fallback below lets WinSW's onfailure policy recover the service.
        });
        child.unref();
      } catch {
        // The non-zero exit fallback below lets WinSW's configured failure policy recover the service.
      }
    }

    // Keep a wrapper-independent fallback. Delay long enough for the JSON response to be flushed;
    // on Windows it also covers a WinSW command that could not be started.
    const timer = setTimeout(() => process.exit(75), 2_000);
    timer.unref();
  }

  async check(): Promise<UpdateStatus> {
    const status = this.base("checking");
    status.currentVersion = await this.currentVersion();
    status.buildVersion = await this.currentBuildVersion();
    status.checkedAt = new Date().toISOString();
    if (!this.config.updateEnabled) {
      status.state = "unavailable";
      status.message = "Remote updates are disabled in .env";
      return status;
    }
    try {
      const remote = await this.git(["ls-remote", "origin", this.config.updateBranch]);
      const latest = remote.split(/\s+/)[0] || status.currentVersion;
      status.latestVersion = latest.slice(0, 12);
      const sourceMatchesRemote = this.commitsMatch(latest, status.currentVersion);
      const buildMatchesSource = this.commitsMatch(status.currentVersion, status.buildVersion || "unknown");
      status.state = !sourceMatchesRemote || !buildMatchesSource ? "available" : "idle";
      status.message = !buildMatchesSource
        ? "The server source and compiled UI are out of sync; rebuild required"
        : status.state === "available" ? "A new version is available" : "This server is up to date";
    } catch {
      status.state = "failed";
      status.message = "Unable to check the Git remote";
    }
    return status;
  }

  async status(): Promise<UpdateStatus> {
    // A read-only status call is also the server-side polling point used by the UI.
    return this.check();
  }

  authorize(token: string | undefined, authenticated: boolean): void {
    if (this.config.updateEnabled !== true) throw new AppError("UPDATE_DISABLED", "Remote updates are disabled in .env", 403);
    if (this.config.authEnabled === true && authenticated) return;
    if (!this.config.updateToken || !token || token !== this.config.updateToken) throw new AppError("AUTH_REQUIRED", "An update token is required", 401);
  }

  async update(): Promise<UpdateStatus> {
    if (this.restartScheduled) throw new AppError("UPDATE_IN_PROGRESS", "The service is restarting; wait for it to come back online", 409);
    if (this.running) throw new AppError("UPDATE_IN_PROGRESS", "An update is already running", 409);
    this.running = true;
    const status = this.base("updating");
    try {
      if (!/^[A-Za-z0-9._/-]+$/.test(this.config.updateBranch) || this.config.updateBranch.startsWith("-")) throw new AppError("UPDATE_FAILED", "Invalid update branch configuration", 500);
      await this.assertTrackedTreeClean("before pull");
      await this.git(["pull", "--ff-only", "origin", this.config.updateBranch]);
      // The service normally runs with NODE_ENV=production, but the production
      // build still needs devDependencies such as vue-tsc and Vite.
      // npm ci validates package-lock.json and installs it without rewriting the
      // dependency graph, unlike npm install in the tracked checkout.
      await this.npm(["ci", "--include=dev"]);
      await this.assertTrackedTreeClean("after dependency installation");
      await this.npm(["run", "build"]);
      await this.assertTrackedTreeClean("after build");
      status.currentVersion = await this.currentVersion();
      status.buildVersion = await this.currentBuildVersion();
      if (!this.commitsMatch(status.currentVersion, status.buildVersion)) {
        throw new AppError("UPDATE_FAILED", "The build completed but its UI bundle does not match the current source commit", 502);
      }
      status.state = "restart-required";
      status.message = "Update installed; requesting a service restart";
      this.requestRestart();
    } catch (error) {
      status.state = "failed";
      const detail = updateErrorDetail(error);
      status.message = error instanceof AppError
        ? error.message
        : detail ? `Update failed: ${detail}` : "Update failed. Check the service and update logs for details.";
      throw new AppError("UPDATE_FAILED", status.message, 502);
    } finally {
      this.running = false;
    }
    return status;
  }

  async restart(): Promise<UpdateStatus> {
    if (this.restartScheduled) throw new AppError("UPDATE_IN_PROGRESS", "The service is restarting; wait for it to come back online", 409);
    if (this.running) throw new AppError("UPDATE_IN_PROGRESS", "An update or restart is already running", 409);
    this.running = true;
    const status = this.base("restart-required");
    try {
      status.currentVersion = await this.currentVersion();
      status.message = this.config.nodeEnv === "production"
        ? "Restart requested; waiting for the service to come back online"
        : "Restart requested (development/test mode does not terminate the process)";
      this.requestRestart();
      return status;
    } finally {
      this.running = false;
    }
  }
}
