import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import { UpdateService } from "../src/services/update";

const statusCommand = "git status --porcelain=v2 --untracked-files=no --ignore-submodules=none";
const temporaryRoots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "escarlet-update-test-"));
  temporaryRoots.push(root);
  const dist = path.join(root, "apps", "web", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, "build-meta.json"), JSON.stringify({ commit: "a59036db357e" }));
  return root;
}

function config(projectRoot: string): AppConfig {
  return {
    port: 3000,
    host: "127.0.0.1",
    appName: "Test",
    nodeEnv: "production",
    lmStudioUrl: null,
    ollamaUrl: null,
    corsOrigins: true,
    dataDir: path.join(projectRoot, "data"),
    authEnabled: false,
    authPassword: null,
    updateEnabled: true,
    updateToken: "test-token",
    updateBranch: "master",
    opencodeBridgeEnabled: false,
    opencodeBridgeToken: null,
    projectRoot,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("remote updater checkout safety", () => {
  it("continues on a clean tree in pull -> npm ci -> build order", async () => {
    const events: string[] = [];
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "a59036db357e",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        return args[0] === "rev-parse" ? "a59036d" : "";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).resolves.toMatchObject({ state: "restart-required", currentVersion: "a59036d" });
    expect(events).toEqual([
      statusCommand,
      "git pull --ff-only origin master",
      "npm ci --include=dev",
      statusCommand,
      "npm run build",
      statusCommand,
      "git rev-parse --short HEAD",
      "restart",
    ]);
  });

  it("restores package-lock.json drift before pull and continues the update", async () => {
    const events: string[] = [];
    let statusChecks = 0;
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "old",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        if (args[0] === "status") {
          statusChecks += 1;
          return statusChecks === 1
            ? "1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa package-lock.json"
            : "";
        }
        return args[0] === "rev-parse" ? "a59036d" : "";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).resolves.toMatchObject({ state: "restart-required" });
    expect(events).toEqual([
      statusCommand,
      "git restore --worktree --source=HEAD -- package-lock.json",
      "git restore --staged -- package-lock.json",
      statusCommand,
      "git pull --ff-only origin master",
      "npm ci --include=dev",
      statusCommand,
      "npm run build",
      statusCommand,
      "git rev-parse --short HEAD",
      "restart",
    ]);
  });

  it("blocks another staged tracked path before pull", async () => {
    const events: string[] = [];
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "old",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        return "1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb apps/server/src/index.ts";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).rejects.toThrow("M. apps/server/src/index.ts");
    expect(events).toEqual([statusCommand]);
  });

  it("does not block untracked or ignored runtime files", async () => {
    const events: string[] = [];
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "old",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        if (args[0] === "status") return "? .env\n? data/conversations.json\n! node_modules/cache\n! apps/web/dist/index.html";
        return args[0] === "rev-parse" ? "a59036d" : "";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).resolves.toMatchObject({ state: "restart-required" });
    expect(events).toContain("git pull --ff-only origin master");
    expect(events).toContain("restart");
  });

  it("aborts before build and restart when npm ci mutates a tracked file", async () => {
    const events: string[] = [];
    let statusChecks = 0;
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "old",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        if (args[0] !== "status") return "";
        statusChecks += 1;
        return statusChecks === 2
          ? "1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa package-lock.json"
          : "";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).rejects.toThrow(".M package-lock.json");
    expect(events).toEqual([
      statusCommand,
      "git pull --ff-only origin master",
      "npm ci --include=dev",
      statusCommand,
    ]);
    expect(events).not.toContain("npm run build");
    expect(events).not.toContain("restart");
  });

  it("aborts before restart when the build mutates a tracked file", async () => {
    const events: string[] = [];
    let statusChecks = 0;
    const service = new UpdateService(config(await fixtureRoot()), {
      runningCommit: "old",
      runGit: async (args) => {
        events.push(`git ${args.join(" ")}`);
        if (args[0] !== "status") return "";
        statusChecks += 1;
        return statusChecks === 3
          ? "1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa apps/server/src/generated.ts"
          : "";
      },
      runNpm: async (args) => { events.push(`npm ${args.join(" ")}`); },
      scheduleRestart: () => { events.push("restart"); },
    });

    await expect(service.update()).rejects.toThrow("apps/server/src/generated.ts");
    expect(events).toContain("npm run build");
    expect(events).not.toContain("restart");
  });
});
