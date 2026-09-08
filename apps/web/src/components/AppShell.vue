<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../services/api";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { useAppStore } from "../stores/app";
import { useConversationStore } from "../stores/conversations";
import { useSystemStore } from "../stores/system";
import { useUiStore } from "../stores/ui";
import { useAuthStore } from "../stores/auth";
import type { ServerVersion } from "../types";
import ToastHost from "./ToastHost.vue";

const app = useAppStore();
const conversations = useConversationStore();
const system = useSystemStore();
const ui = useUiStore();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
let refreshTimer: number | undefined;
let versionTimer: number | undefined;
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
const versionLabel = computed(() => {
  if (!serverVersion.value) return `UI ${clientShortCommit}`;
  if (versionState.value === "synced") return `Build ${clientShortCommit}`;
  return `UI ${clientShortCommit} · run ${serverRunningShortCommit.value} · build ${serverBuildShortCommit.value}`;
});
const versionTitle = computed(() => {
  if (!serverVersion.value) return `UI bundle ${clientCommit}; server version unavailable`;
  return `UI bundle: ${clientCommit}\nServer source: ${serverVersion.value.commit} (${serverVersion.value.branch})\nServer process: ${serverVersion.value.runningCommit}\nServer UI build: ${serverBuildCommit.value}\nBoot: ${serverVersion.value.bootId}`;
});
const metricsTitle = computed(() => {
  const snapshot = system.info;
  if (!snapshot) return "Host telemetry unavailable";
  const gpu = system.primaryGpu;
  const nvidia = snapshot.nvidia.present
    ? (snapshot.nvidia.active ? "NVIDIA active" : "NVIDIA idle")
    : "No NVIDIA GPU";
  const gpuLine = gpu
    ? `${gpu.name}${gpu.usagePercent === null ? "" : ` · GPU ${gpu.usagePercent}%`}${gpu.memoryUsedBytes === null || gpu.memoryTotalBytes === null ? "" : ` · VRAM ${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`}`
    : "No GPU data";
  return `CPU ${formatPercent(snapshot.cpu.usagePercent)}\nRAM ${formatPercent(snapshot.memory.usagePercent)}\n${gpuLine}\n${nvidia}`;
});

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}
function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function refreshVersion(): Promise<void> {
  try {
    serverVersion.value = await api.version();
  } catch {
    serverVersion.value = null;
  }
}

onMounted(async () => {
  system.startPolling(3_000);
  await conversations.hydrateRemote();
  await app.refresh();
  refreshTimer = window.setInterval(() => void app.refresh(), 15_000);
});
onMounted(() => {
  void refreshVersion();
  versionTimer = window.setInterval(() => void refreshVersion(), 60_000);
});
onUnmounted(() => {
  system.stopPolling();
  if (refreshTimer !== undefined) {
    window.clearInterval(refreshTimer);
  }
  if (versionTimer !== undefined) {
    window.clearInterval(versionTimer);
  }
});

function newConversation(): void {
  const selected = app.selectedModel;
  conversations.createConversation(selected?.provider ?? "lmstudio", selected?.id ?? "");
  router.push({ name: "chat" });
  ui.setDrawer(false);
}
function openConversation(id: string): void {
  conversations.selectConversation(id);
  router.push({ name: "chat" });
  ui.setDrawer(false);
}
function renameConversation(id: string, currentTitle: string): void {
  const nextTitle = window.prompt("Conversation name", currentTitle);
  if (nextTitle) {
    conversations.renameConversation(id, nextTitle);
  }
}
function removeConversation(id: string): void {
  if (window.confirm("Delete this conversation?")) {
    conversations.removeConversation(id);
  }
}
</script>

<template>
  <div class="min-h-screen bg-canvas text-ink" :class="{ 'chat-shell': route.name === 'chat' }">
    <div v-if="ui.drawerOpen" class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden" @click="ui.setDrawer(false)" />
    <aside class="sidebar" :class="{ 'sidebar-open': ui.drawerOpen }" aria-label="Main navigation">
      <div class="flex items-center gap-3 px-4 py-5">
        <img class="brand-mark" src="/icon.svg" alt="" aria-hidden="true" />
        <div>
          <p class="text-sm font-semibold tracking-wide text-ink">Escarlet Local AI UI</p>
          <p class="text-[11px] text-muted">Private model workspace</p>
        </div>
        <button class="icon-button ml-auto lg:hidden" aria-label="Close navigation" @click="ui.setDrawer(false)">×</button>
      </div>

      <div class="px-3">
        <button class="primary-button w-full justify-center" @click="newConversation">
          <span aria-hidden="true">＋</span> New conversation
        </button>
      </div>

      <nav class="mt-5 space-y-1 px-3" aria-label="Workspace">
        <RouterLink to="/" class="nav-link" @click="ui.setDrawer(false)"><span aria-hidden="true">⌁</span> Chat</RouterLink>
        <RouterLink to="/models" class="nav-link" @click="ui.setDrawer(false)"><span aria-hidden="true">◈</span> Models</RouterLink>
        <RouterLink to="/system" class="nav-link" @click="ui.setDrawer(false)"><span aria-hidden="true">◌</span> System</RouterLink>
      </nav>

      <div class="mt-7 flex min-h-0 flex-1 flex-col px-3">
        <div class="mb-2 flex items-center justify-between px-2">
          <p class="section-label">Conversations</p>
          <span class="text-[11px] text-muted">{{ conversations.conversations.length }}</span>
        </div>
        <div class="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <div v-for="conversation in conversations.conversations" :key="conversation.id" class="conversation-row" :class="{ active: conversations.activeId === conversation.id }">
            <button class="min-w-0 flex-1 truncate text-left" :title="conversation.title" @click="openConversation(conversation.id)">{{ conversation.title }}</button>
            <div class="conversation-actions">
              <button aria-label="Rename conversation" title="Rename" @click="renameConversation(conversation.id, conversation.title)">···</button>
              <button aria-label="Delete conversation" title="Delete" @click="removeConversation(conversation.id)">×</button>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-auto border-t border-line p-3">
        <div class="provider-mini-list">
          <div v-for="provider in app.providers" :key="provider.id" class="provider-mini" :title="provider.message || `${provider.name} ${provider.online ? 'online' : 'offline'}`">
            <span class="status-dot" :class="provider.online ? 'online' : 'offline'" aria-hidden="true" />
            <span>{{ provider.id === 'lmstudio' ? 'LM Studio' : 'Ollama' }}</span>
            <span class="ml-auto text-[10px] text-muted">{{ provider.online ? 'Online' : 'Offline' }}</span>
          </div>
        </div>
        <button v-if="auth.enabled" class="text-button mt-3 w-full text-left" @click="auth.logout">Sign out</button>
      </div>
    </aside>

    <div class="app-frame">
      <header class="topbar">
        <button class="icon-button lg:hidden" aria-label="Open navigation" @click="ui.setDrawer(true)">☰</button>
        <div class="flex min-w-0 items-center gap-3">
          <img class="brand-mark small" src="/icon.svg" alt="" aria-hidden="true" />
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold lg:hidden">Escarlet Local AI UI</p>
            <p class="hidden text-sm font-medium text-muted lg:block">{{ route.name === 'chat' ? 'Chat workspace' : route.name === 'models' ? 'Model library' : 'System monitor' }}</p>
          </div>
        </div>
        <div class="ml-auto flex items-center gap-2 sm:gap-3">
          <div class="host-metrics" :title="metricsTitle" aria-label="Host resource usage">
            <span class="host-metric host-metric-priority"><span class="host-metric-label">CPU</span>{{ formatPercent(system.info?.cpu.usagePercent ?? null) }}</span>
            <span class="host-metric"><span class="host-metric-label">RAM</span>{{ formatPercent(system.info?.memory.usagePercent ?? null) }}</span>
            <span class="host-metric host-metric-priority"><span class="host-metric-label">VRAM</span>{{ formatPercent(system.vramUsagePercent) }}</span>
            <span class="host-metric"><span class="host-metric-label">GPU</span>{{ formatPercent(system.primaryGpu?.usagePercent ?? null) }}</span>
            <span class="host-metric nvidia-metric" :class="system.info?.nvidia.active ? 'nvidia-active' : system.info?.nvidia.present ? 'nvidia-idle' : 'nvidia-missing'">
              <span class="host-metric-label">NV</span>{{ system.info?.nvidia.active ? 'On' : system.info?.nvidia.present ? 'Idle' : '—' }}
            </span>
          </div>
          <div class="hidden items-center gap-3 sm:flex" aria-label="Provider status">
            <span v-for="provider in app.providers" :key="provider.id" class="status-pill" :title="provider.message || `${provider.name} ${provider.online ? 'online' : 'offline'}`">
              <span class="status-dot" :class="provider.online ? 'online' : 'offline'" aria-hidden="true" />
              {{ provider.id === 'lmstudio' ? 'LM' : 'OL' }}
            </span>
          </div>
          <span class="version-indicator" :class="`version-${versionState}`" :title="versionTitle" aria-label="Application version">
            <span class="status-dot" :class="versionState === 'synced' ? 'online' : 'offline'" aria-hidden="true" />
            <span>{{ versionLabel }}</span>
          </span>
          <button class="icon-button" :aria-label="ui.isDark ? 'Use light theme' : 'Use dark theme'" :title="ui.isDark ? 'Light theme' : 'Dark theme'" @click="ui.toggleTheme()">
            {{ ui.isDark ? '☼' : '☾' }}
          </button>
        </div>
      </header>

      <main class="main-content">
        <RouterView />
      </main>
    </div>
    <ToastHost />
  </div>
</template>
