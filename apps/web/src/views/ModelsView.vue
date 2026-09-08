<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAppStore } from "../stores/app";
import type { ModelInfo, ProviderId } from "../types";
import ModelCapabilities from "../components/ModelCapabilities.vue";

const app = useAppStore();
const ollamaModelName = ref("");
const lmStudioModelName = ref("");
const downloading = ref<"ollama" | "lmstudio" | null>(null);
const groups = computed(() => [
  { id: "lmstudio" as const, name: "LM Studio", description: "Local models managed by LM Studio", models: app.models.filter((model) => model.provider === "lmstudio") },
  { id: "ollama" as const, name: "Ollama", description: "Models installed in your Ollama library", models: app.models.filter((model) => model.provider === "ollama") },
]);
onMounted(() => { if (app.models.length === 0) void app.refresh(); });
function modelAction(model: ModelInfo): void {
  if (model.loaded) void app.unload(model);
  else void app.load(model);
}
function providerOnline(id: ProviderId): boolean {
  return app.provider(id).online;
}
async function downloadOllama(): Promise<void> {
  if (!ollamaModelName.value.trim() || downloading.value) return;
  downloading.value = "ollama";
  try {
    await app.downloadOllamaModel(ollamaModelName.value);
    ollamaModelName.value = "";
  } finally {
    downloading.value = null;
  }
}
async function downloadLmStudio(): Promise<void> {
  if (!lmStudioModelName.value.trim() || downloading.value) return;
  downloading.value = "lmstudio";
  try {
    await app.downloadLmStudioModel(lmStudioModelName.value);
    lmStudioModelName.value = "";
  } finally {
    downloading.value = null;
  }
}
function deleteModel(model: ModelInfo): void {
  const label = model.provider === "ollama" ? "Ollama" : "LM Studio";
  if (!window.confirm(`Delete ${model.name} from ${label}? This removes the local model files.`)) return;
  if (model.provider === "ollama") void app.deleteOllamaModel(model);
  else void app.deleteLmStudioModel(model);
}
function canDelete(model: ModelInfo): boolean {
  return model.deletable === true || model.provider === "ollama" || model.provider === "lmstudio";
}
function formatSize(bytes?: number): string {
  if (!bytes) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
</script>

<template>
  <section class="page-shell">
    <div class="page-heading">
      <div><p class="eyebrow">Control centre</p><h1>Models</h1><p class="page-subtitle">See what is installed, what is warm, and what is ready to use.</p></div>
      <button class="secondary-button" :disabled="app.loadingModels" @click="app.refresh"><span :class="{ spin: app.loadingModels }" aria-hidden="true">↻</span> Refresh</button>
    </div>
    <div class="space-y-8">
      <section v-for="group in groups" :key="group.id">
        <div class="mb-3 flex items-center gap-3"><div class="provider-heading-dot" :class="group.id" aria-hidden="true" /><div><h2 class="section-heading">{{ group.name }}</h2><p class="text-xs text-muted">{{ group.description }}</p></div><span class="status-pill ml-auto" :class="providerOnline(group.id) ? 'status-online' : 'status-offline'"><span class="status-dot" :class="providerOnline(group.id) ? 'online' : 'offline'" />{{ providerOnline(group.id) ? 'Online' : 'Offline' }}</span></div>
        <div v-if="group.models.length" class="model-grid">
          <article v-for="model in group.models" :key="app.modelKey(model)" class="model-card" :class="{ 'model-loaded': model.loaded }">
            <div class="flex items-start justify-between gap-3"><div class="model-icon" :class="group.id" aria-hidden="true"><img v-if="group.id === 'lmstudio'" class="model-icon-image" src="/icon.svg" alt="" /><span v-else>◒</span></div><span class="load-badge" :class="model.loaded ? 'loaded' : 'unloaded'"><span class="status-dot" :class="model.loaded ? 'online' : 'offline'" />{{ model.loaded ? 'Loaded' : 'Not loaded' }}</span></div>
            <div class="mt-4 min-w-0"><h3 class="truncate text-base font-semibold" :title="model.name">{{ model.name }}</h3><p class="mt-1 truncate text-xs text-muted" :title="model.id">{{ model.id }}</p></div>
            <ModelCapabilities :model="model" />
            <div class="mt-4 flex items-center gap-3 text-[11px] text-muted"><span v-if="model.size">{{ formatSize(model.size) }}</span><span v-if="model.contextLength">{{ model.contextLength.toLocaleString() }} ctx</span><span v-if="!model.size && !model.contextLength">Discovered from provider</span></div>
            <button class="action-button mt-5 w-full" :class="model.loaded ? 'unload' : 'load'" :disabled="app.isBusy(model) || !providerOnline(model.provider)" @click="modelAction(model)"><span v-if="app.isBusy(model)" class="spin" aria-hidden="true">◌</span><span v-else aria-hidden="true">{{ model.loaded ? '↓' : '↑' }}</span>{{ app.isBusy(model) ? (model.loaded ? 'Unloading…' : 'Loading…') : (model.loaded ? 'Unload model' : 'Load model') }}</button>
            <button v-if="canDelete(model)" class="text-button mt-3 w-full text-center" :disabled="app.isBusy(model) || !providerOnline(model.provider)" @click="deleteModel(model)">{{ app.isBusy(model) && app.actionOperation === 'delete' ? 'Deleting…' : `Delete from ${group.name}` }}</button>
          </article>
        </div>
        <div v-else class="empty-provider"><span aria-hidden="true">◌</span><div><p>{{ providerOnline(group.id) ? 'No models discovered yet' : `${group.name} is offline` }}</p><span>{{ providerOnline(group.id) ? 'Refresh to check for newly available models.' : 'Start the provider or update its URL in .env.' }}</span></div></div>
        <form v-if="group.id === 'lmstudio'" class="download-card download-card-lmstudio" @submit.prevent="downloadLmStudio">
          <div><p class="font-semibold">Add an LM Studio model</p><p class="mt-1 text-xs text-muted">Enter a catalog key or Hugging Face URL, for example <code>ibm/granite-4-micro</code> or <code>https://huggingface.co/lmstudio-community/gpt-oss-20b-GGUF</code>.</p></div>
          <div class="download-row"><label class="sr-only" for="lmstudio-model-name">LM Studio model key</label><input id="lmstudio-model-name" v-model="lmStudioModelName" class="model-input" placeholder="publisher/model" :disabled="!providerOnline('lmstudio') || downloading === 'lmstudio'" /><button class="primary-button" type="submit" :disabled="!providerOnline('lmstudio') || downloading === 'lmstudio' || !lmStudioModelName.trim()">{{ downloading === 'lmstudio' ? 'Downloading…' : 'Download model' }}</button></div>
        </form>
        <form v-if="group.id === 'ollama'" class="download-card" @submit.prevent="downloadOllama">
          <div><p class="font-semibold">Add an Ollama model</p><p class="mt-1 text-xs text-muted">Enter any model name from the Ollama library, for example <code>llama3.2</code> or <code>qwen2.5:7b</code>.</p></div>
          <div class="download-row"><label class="sr-only" for="ollama-model-name">Ollama model name</label><input id="ollama-model-name" v-model="ollamaModelName" class="model-input" placeholder="model:tag" :disabled="!providerOnline('ollama') || downloading === 'ollama'" /><button class="primary-button" type="submit" :disabled="!providerOnline('ollama') || downloading === 'ollama' || !ollamaModelName.trim()">{{ downloading === 'ollama' ? 'Downloading…' : 'Download model' }}</button></div>
        </form>
      </section>
    </div>
  </section>
</template>
