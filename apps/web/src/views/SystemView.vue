<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, ApiError } from "../services/api";
import { updateServiceWorker } from "../services/pwa";
import { useSystemStore } from "../stores/system";
import { useUiStore } from "../stores/ui";
import type { ServerVersion, UpdateStatus } from "../types";

const ui = useUiStore();
const system = useSystemStore();
const info = computed(() => system.info);
const loading = computed(() => system.loading && !system.info);
const update = ref<UpdateStatus | null>(null);
const updateBusy = ref(false);
const restartBusy = ref(false);
const updateToken = ref(localStorage.getItem("local-ai-update-token") || "");
const clientCommit = import.meta.env.VITE_BUILD_COMMIT || "dev";
const clientShortCommit = clientCommit === "dev" ? clientCommit : clientCommit.slice(0, 7);
const serverVersion = ref<ServerVersion | null>(null);
const serverBuildCommit = computed(() => serverVersion.value?.buildCommit || "unknown");
const serverBuildShortCommit = computed(() => serverVersion.value?.buildShortCommit || "unknown");
const serverRunningCommit = computed(() => serverVersion.value?.runningCommit || "unknown");
const serverRunningShortCommit = computed(() => serverVersion.value?.runningShortCommit || "unknown");
const versionState = computed<"synced" | "mismatch" | "unavailable">(() => {
  if (!serverVersion.value || serverBuildCommit.value === "unknown" || serverRunningCommit.value === "unknown") return "unavailable";
  const uiMatchesBuild = serverBuildCommit.value === clientCommit || serverBuildShortCommit.value === clientCommit;
  const processMatchesBuild = serverRunningCommit.value === serverBuildCommit.value || serverRunningCommit.value.startsWith(serverBuildCommit.value) || serverBuildCommit.value.startsWith(serverRunningCommit.value);
  return uiMatchesBuild && processMatchesBuild ? "synced" : "mismatch";
});
const nvidiaStatus = computed(() => {
  if (!info.value) return { label: "Checking…", detail: "Waiting for the first host snapshot.", tone: "muted" as const };
  if (!info.value.nvidia.present) return { label: "No NVIDIA GPU", detail: "nvidia-smi did not report an adapter on this host.", tone: "muted" as const };
  if (info.value.nvidia.active) return { label: "NVIDIA in use", detail: "VRAM or GPU utilisation shows active work, which usually means a loaded model is on the GPU.", tone: "active" as const };
  return { label: "NVIDIA idle", detail: "An NVIDIA GPU is present, but current VRAM and utilisation look idle.", tone: "idle" as const };
});
const primaryGpu = computed(() => system.primaryGpu);
const primaryVramPercent = computed(() => system.vramUsagePercent);
const updateReloadDelayMs = 5_000;
let updateTimer: number | undefined;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function refreshUpdate(): Promise<void> {
  try { update.value = await api.updateStatus(); } catch { update.value = null; }
}
async function refreshVersion(): Promise<void> {
  try { serverVersion.value = await api.version(); } catch { serverVersion.value = null; }
}
async function checkForUpdate(): Promise<void> {
  updateBusy.value = true;
  localStorage.setItem("local-ai-update-token", updateToken.value);
  try { update.value = await api.checkForUpdate(updateToken.value || undefined); }
  catch (error) { ui.showToast(error instanceof ApiError ? error.message : "Unable to check for updates", "error"); }
  finally { updateBusy.value = false; }
}
function versionsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || left === "unknown" || right === "unknown") return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}
async function waitForUpdatedServer(expectedBuild?: string, previousStartedAt?: string): Promise<boolean> {
  await sleep(updateReloadDelayMs);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const [health, version] = await Promise.all([api.health(), api.version()]);
      serverVersion.value = version;
      const serverRestarted = !previousStartedAt || version.startedAt !== previousStartedAt;
      const buildReady = !expectedBuild || versionsMatch(version.buildCommit, expectedBuild);
      const processReady = versionsMatch(version.runningCommit, version.buildCommit);
      if (health.status === "ok" && serverRestarted && buildReady && processReady) return true;
    } catch { /* The service is expected to be unreachable while WinSW restarts it. */ }
    if (attempt < 9) await sleep(1_000);
  }
  return false;
}

function isExpectedRestartDisconnect(error: unknown): boolean {
  return error instanceof ApiError && error.code === "SERVER_OFFLINE";
}
function forceReload(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("update", Date.now().toString());
  window.location.replace(url.toString());
}
async function installUpdate(): Promise<void> {
  if (!window.confirm("Pull the latest code, rebuild the app, and restart the service?")) return;
  updateBusy.value = true;
  try {
    const previous = await api.version().catch(() => null);
    let expectedBuild: string | undefined;
    try {
      update.value = await api.triggerUpdate(updateToken.value || undefined);
      expectedBuild = update.value.buildVersion || update.value.currentVersion;
      ui.showToast("Update installed. Waiting for the service confirmation…", "success");
    } catch (error) {
      if (!isExpectedRestartDisconnect(error)) throw error;
      ui.showToast("The service disconnected while restarting. Waiting for confirmation…", "info");
    }
    const ready = await waitForUpdatedServer(expectedBuild, previous?.startedAt);
    if (ready) {
      await refreshUpdate();
      await updateServiceWorker(false);
      forceReload();
    }
    else {
      await refreshUpdate();
      ui.showToast("The update request was received, but a new running service could not be confirmed. Check the Windows service logs.", "error");
    }
  }
  catch (error) { ui.showToast(error instanceof ApiError ? error.message : "Unable to install update", "error"); }
  finally { updateBusy.value = false; }
}
async function restartService(): Promise<void> {
  if (!window.confirm("Restart the Escarlet Local AI UI service now?")) return;
  restartBusy.value = true;
  localStorage.setItem("local-ai-update-token", updateToken.value);
  try {
    const previous = await api.version().catch(() => null);
    try {
      await api.restartService(updateToken.value || undefined);
      ui.showToast("Service restart requested. Waiting for confirmation…", "success");
    } catch (error) {
      if (!isExpectedRestartDisconnect(error)) throw error;
      ui.showToast("The service disconnected while restarting. Waiting for confirmation…", "info");
    }
    const ready = await waitForUpdatedServer(undefined, previous?.startedAt);
    if (ready) {
      await refreshUpdate();
      await updateServiceWorker(false);
      forceReload();
    } else {
      await refreshUpdate();
      ui.showToast("The service did not return with a new start time. Check its Windows service logs.", "error");
    }
  } catch (error) {
    ui.showToast(error instanceof ApiError ? error.message : "Unable to restart the service", "error");
  } finally {
    restartBusy.value = false;
  }
}
onMounted(() => {
  system.startPolling(3_000);
  void refreshUpdate();
  void refreshVersion();
  updateTimer = window.setInterval(() => { void refreshUpdate(); void refreshVersion(); }, 60_000);
});
onUnmounted(() => {
  system.stopPolling();
  if (updateTimer !== undefined) window.clearInterval(updateTimer);
});
function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
}
function vramPercent(used: number | null, total: number | null): number {
  if (used === null || !total) return 0;
  return Math.min(100, Number(((used / total) * 100).toFixed(1)));
}
</script>

<template>
  <section class="page-shell">
    <div class="page-heading"><div><p class="eyebrow">Host dashboard</p><h1>System</h1><p class="page-subtitle">Live CPU, memory, VRAM, and NVIDIA activity for this machine.</p></div><span class="live-indicator"><span class="pulse-dot" /> updates every 3 seconds</span></div>
    <div v-if="loading && !info" class="skeleton-grid"><div v-for="n in 4" :key="n" class="skeleton-card" /></div>
    <template v-else-if="info">
      <div class="system-grid">
        <article class="metric-card"><div class="metric-top"><span class="metric-label">CPU</span><span class="metric-symbol" aria-hidden="true">⌁</span></div><div class="metric-value">{{ info.cpu.usagePercent === null ? '—' : `${info.cpu.usagePercent}%` }}</div><div class="progress-track"><div class="progress-fill purple" :style="{ width: `${info.cpu.usagePercent ?? 0}%` }" /></div><p class="metric-foot">{{ info.cpu.cores === null ? 'Core count unavailable' : `${info.cpu.cores} logical cores` }}</p></article>
        <article class="metric-card"><div class="metric-top"><span class="metric-label">Memory</span><span class="metric-symbol" aria-hidden="true">▦</span></div><div class="metric-value">{{ info.memory.usagePercent === null ? '—' : `${info.memory.usagePercent}%` }}</div><div class="progress-track"><div class="progress-fill purple" :style="{ width: `${info.memory.usagePercent ?? 0}%` }" /></div><p class="metric-foot">{{ formatBytes(info.memory.usedBytes) }} / {{ formatBytes(info.memory.totalBytes) }}</p></article>
        <article class="metric-card"><div class="metric-top"><span class="metric-label">VRAM</span><span class="metric-symbol" aria-hidden="true">▰</span></div><div class="metric-value">{{ primaryVramPercent === null ? '—' : `${primaryVramPercent}%` }}</div><div class="progress-track"><div class="progress-fill teal" :style="{ width: `${primaryVramPercent ?? 0}%` }" /></div><p class="metric-foot">{{ formatBytes(primaryGpu?.memoryUsedBytes ?? null) }} / {{ formatBytes(primaryGpu?.memoryTotalBytes ?? null) }}</p></article>
        <article class="metric-card"><div class="metric-top"><span class="metric-label">GPU</span><span class="metric-symbol" aria-hidden="true">◈</span></div><div class="metric-value">{{ primaryGpu?.usagePercent === null || primaryGpu?.usagePercent === undefined ? '—' : `${primaryGpu.usagePercent}%` }}</div><div class="progress-track"><div class="progress-fill teal" :style="{ width: `${primaryGpu?.usagePercent ?? 0}%` }" /></div><p class="metric-foot truncate" :title="primaryGpu?.name || 'No GPU reported'">{{ primaryGpu?.name || 'No GPU reported' }}</p></article>
      </div>
      <section class="system-section">
        <div class="section-heading-row"><div><h2 class="section-heading">NVIDIA status</h2><p class="text-xs text-muted">Quick answer for whether models appear to be using the NVIDIA GPU.</p></div></div>
        <article class="nvidia-card" :class="`nvidia-${nvidiaStatus.tone}`">
          <div class="nvidia-card-top">
            <div class="min-w-0">
              <p class="metric-label">Graphics path</p>
              <p class="mt-2 text-lg font-semibold">{{ nvidiaStatus.label }}</p>
              <p class="mt-1 text-xs text-muted">{{ nvidiaStatus.detail }}</p>
            </div>
            <span class="status-pill shrink-0" :class="info.nvidia.active ? 'status-online' : 'status-offline'">{{ info.nvidia.source === 'nvidia-smi' ? 'nvidia-smi' : info.nvidia.source }}</span>
          </div>
        </article>
      </section>
      <section class="system-section"><div class="section-heading-row"><div><h2 class="section-heading">Graphics</h2><p class="text-xs text-muted">Detected adapters with utilisation and VRAM when available.</p></div></div><div v-if="info.gpu.length" class="gpu-grid"><article v-for="gpu in info.gpu" :key="gpu.name" class="gpu-card" :class="{ 'gpu-active': gpu.active }"><div class="gpu-icon" aria-hidden="true">▰</div><div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-3"><h3 class="truncate font-semibold" :title="gpu.name">{{ gpu.name }}</h3><span class="load-badge shrink-0" :class="gpu.active ? 'loaded' : 'unloaded'"><span class="status-dot" :class="gpu.active ? 'online' : 'offline'" />{{ gpu.active ? 'Active' : 'Idle' }}</span></div><p class="mt-1 text-xs text-muted">{{ gpu.nvidia ? 'NVIDIA' : (gpu.vendor || 'GPU') }} · {{ gpu.usagePercent === null ? 'Utilisation unavailable' : `${gpu.usagePercent}% GPU` }}</p><div class="progress-track"><div class="progress-fill teal" :style="{ width: `${vramPercent(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}%` }" /></div><p class="mt-2 text-xs text-muted">{{ formatBytes(gpu.memoryUsedBytes) }} used · {{ formatBytes(gpu.memoryTotalBytes) }} total VRAM</p></div></article></div><div v-else class="empty-provider"><span aria-hidden="true">◌</span><div><p>No graphics adapter data reported</p><span>The operating system did not expose GPU telemetry.</span></div></div></section>
      <section class="system-section"><div class="section-heading-row"><div><h2 class="section-heading">Host</h2><p class="text-xs text-muted">Environment details for this Escarlet Local AI UI server.</p></div></div><div class="host-card"><div><span class="metric-label">Operating system</span><p class="mt-2 font-medium">{{ info.operatingSystem }}</p></div><div><span class="metric-label">Uptime</span><p class="mt-2 font-medium">{{ formatUptime(info.uptimeSeconds) }}</p></div><div><span class="metric-label">Last updated</span><p class="mt-2 font-medium">{{ new Date(info.capturedAt).toLocaleTimeString() }}</p></div></div></section>
      <section class="system-section"><div class="section-heading-row"><div><h2 class="section-heading">Build identity</h2><p class="text-xs text-muted">Use this to confirm that the browser bundle and compiled UI served by the server come from the same commit.</p></div></div><div class="version-grid"><article class="metric-card"><span class="metric-label">UI bundle</span><p class="metric-value version-value" :title="clientCommit">{{ clientShortCommit }}</p></article><article class="metric-card"><span class="metric-label">Server UI build</span><p class="metric-value version-value" :title="serverBuildCommit">{{ serverBuildShortCommit }}</p><p class="metric-foot">Running {{ serverRunningShortCommit }} · source {{ serverVersion?.shortCommit || 'unavailable' }} · {{ serverVersion?.branch || 'version endpoint unavailable' }}</p></article><article class="metric-card"><span class="metric-label">Status</span><p class="metric-value version-value" :class="versionState === 'synced' ? 'version-ok' : versionState === 'mismatch' ? 'version-warning' : ''">{{ versionState === 'synced' ? 'Synced' : versionState === 'mismatch' ? 'Mismatch' : 'Unknown' }}</p><p class="metric-foot">{{ serverVersion?.startedAt ? `Started ${new Date(serverVersion.startedAt).toLocaleString()}` : 'Refresh to check again' }}</p></article></div></section>
      <section class="system-section update-section"><div class="section-heading-row"><div><h2 class="section-heading">Remote updates</h2><p class="text-xs text-muted">Safely pull, build, restart, and verify this service from the UI when enabled in .env.</p></div></div><article class="update-card"><div class="flex min-w-0 items-start justify-between gap-4"><div><p class="metric-label">Status</p><p class="mt-2 font-medium">{{ update?.message || 'Checking update configuration…' }}</p><p v-if="update?.currentVersion" class="mt-1 text-xs text-muted">Source: {{ update.currentVersion }}<span v-if="update.buildVersion"> · UI build: {{ update.buildVersion.slice(0, 12) }}</span><span v-if="update.latestVersion"> · Remote: {{ update.latestVersion }}</span></p></div><span v-if="update" class="status-pill" :class="update.state === 'available' ? 'status-online' : 'status-offline'">{{ update.state }}</span></div><div v-if="update?.enabled && update.requiresToken" class="mt-4"><label class="field-label">Update token <input v-model="updateToken" type="password" autocomplete="off" placeholder="Configured in UPDATE_TOKEN" /></label></div><div class="mt-4 flex flex-wrap gap-2"><button class="secondary-button" :disabled="updateBusy || restartBusy || !update?.enabled" @click="checkForUpdate">{{ updateBusy ? 'Checking…' : 'Check now' }}</button><button v-if="update?.state === 'available'" class="primary-button" :disabled="updateBusy || restartBusy" @click="installUpdate">{{ updateBusy ? 'Updating…' : 'Install and restart' }}</button><button class="secondary-button" :disabled="updateBusy || restartBusy || !update?.enabled" @click="restartService">{{ restartBusy ? 'Restarting…' : 'Restart service' }}</button></div></article></section>
    </template>
  </section>
</template>
