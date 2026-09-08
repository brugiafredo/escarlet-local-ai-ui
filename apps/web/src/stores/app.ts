import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, ApiError } from "../services/api";
import type { ModelInfo, ModelOperation, ProviderId, ProviderStatus } from "../types";
import { useConversationStore } from "./conversations";
import { useUiStore } from "./ui";

export const useAppStore = defineStore("app", () => {
  const providers = ref<ProviderStatus[]>([
    { id: "lmstudio", name: "LM Studio", online: false },
    { id: "ollama", name: "Ollama", online: false },
  ]);
  const models = ref<ModelInfo[]>([]);
  const loadingModels = ref(false);
  const serverOnline = ref(true);
  const actionKey = ref<string | null>(null);
  const actionOperation = ref<ModelOperation | null>(null);
  const actionError = ref<string | null>(null);
  const selectedKey = ref<string | null>(localStorage.getItem("local-ai-selected-model"));

  const selectedModel = computed(() => models.value.find((model) => `${model.provider}:${model.id}` === selectedKey.value) ?? null);
  const onlineProviders = computed(() => providers.value.filter((provider) => provider.online));

  function modelKey(model: Pick<ModelInfo, "provider" | "id">): string {
    return `${model.provider}:${model.id}`;
  }
  function selectModel(model: ModelInfo): void {
    selectedKey.value = modelKey(model);
    localStorage.setItem("local-ai-selected-model", selectedKey.value);
  }
  function provider(providerId: ProviderId): ProviderStatus {
    return providers.value.find((item) => item.id === providerId) ?? { id: providerId, name: providerId, online: false };
  }
  function setServerOnline(online: boolean): void {
    serverOnline.value = online;
  }
  async function refresh(): Promise<void> {
    loadingModels.value = true;
    try {
      const [nextProviders, nextModels] = await Promise.all([api.providers(), api.models()]);
      serverOnline.value = true;
      providers.value = nextProviders;
      models.value = nextModels;
      if (!selectedModel.value && nextModels.length > 0) {
        const loaded = nextModels.find((model) => model.loaded) ?? nextModels[0];
        if (loaded) {
          selectModel(loaded);
        }
      }
    } catch (error) {
      serverOnline.value = false;
      const ui = useUiStore();
      ui.showToast(error instanceof ApiError ? error.message : "Unable to refresh providers", "error");
    } finally {
      loadingModels.value = false;
    }
  }
  async function load(model: ModelInfo, contextLength?: number): Promise<void> {
    const ui = useUiStore();
    beginAction(model, "load");
    try {
      await api.loadModel(model.provider, model.id, contextLength);
      await refresh();
      const refreshed = models.value.find((item) => modelKey(item) === modelKey(model));
      if (refreshed) {
        selectModel(refreshed);
      }
      ui.showToast(`${model.name} loaded`, "success");
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Unable to load model");
    } finally {
      endAction();
    }
  }
  async function unload(model: ModelInfo): Promise<void> {
    const ui = useUiStore();
    beginAction(model, "unload");
    try {
      await api.unloadModel(model.provider, model.id);
      await refresh();
      ui.showToast(`${model.name} unloaded`, "success");
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Unable to unload model");
    } finally {
      endAction();
    }
  }
  async function downloadModel(providerId: ProviderId, modelName: string): Promise<void> {
    const name = modelName.trim();
    if (!name) {
      actionError.value = providerId === "ollama" ? "Enter an Ollama model name first." : "Enter an LM Studio model key first.";
      return;
    }
    const model = { provider: providerId, id: name };
    const ui = useUiStore();
    beginAction(model, "download");
    try {
      await api.downloadModel(providerId, name);
      await refresh();
      ui.showToast(`${name} downloaded`, "success");
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : `Unable to download ${providerId === "ollama" ? "Ollama" : "LM Studio"} model`);
    } finally {
      endAction();
    }
  }
  async function downloadOllamaModel(modelName: string): Promise<void> {
    await downloadModel("ollama", modelName);
  }
  async function downloadLmStudioModel(modelName: string): Promise<void> {
    await downloadModel("lmstudio", modelName);
  }
  async function deleteProviderModel(model: ModelInfo): Promise<void> {
    const wasSelected = selectedKey.value === modelKey(model);
    const ui = useUiStore();
    beginAction(model, "delete");
    try {
      await api.deleteModel(model.provider, model.id);
      if (wasSelected) selectedKey.value = null;
      await refresh();
      if (wasSelected) {
        const replacement = selectedModel.value;
        const conversationStore = useConversationStore();
        if (replacement) {
          for (const conversation of conversationStore.conversations) {
            if (conversation.provider === model.provider && conversation.model === model.id) {
              conversationStore.updateConversation(conversation.id, { provider: replacement.provider, model: replacement.id });
            }
          }
        }
      }
      ui.showToast(`${model.name} deleted`, "success");
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : `Unable to delete ${model.provider === "ollama" ? "Ollama" : "LM Studio"} model`);
    } finally {
      endAction();
    }
  }
  async function deleteOllamaModel(model: ModelInfo): Promise<void> {
    if (model.provider !== "ollama") return;
    await deleteProviderModel(model);
  }
  async function deleteLmStudioModel(model: ModelInfo): Promise<void> {
    if (model.provider !== "lmstudio") return;
    await deleteProviderModel(model);
  }
  function beginAction(model: Pick<ModelInfo, "provider" | "id">, operation: ModelOperation): void {
    actionKey.value = modelKey(model);
    actionOperation.value = operation;
    actionError.value = null;
  }
  function endAction(): void {
    actionKey.value = null;
    actionOperation.value = null;
  }
  function setActionError(message: string): void {
    actionError.value = message;
    useUiStore().showToast(message, "error");
  }
  function isBusy(model: ModelInfo): boolean {
    return actionKey.value === modelKey(model);
  }

  return { providers, models, loadingModels, serverOnline, actionKey, actionOperation, actionError, selectedModel, onlineProviders, modelKey, selectModel, provider, setServerOnline, refresh, load, unload, downloadOllamaModel, downloadLmStudioModel, deleteOllamaModel, deleteLmStudioModel, isBusy };
});
