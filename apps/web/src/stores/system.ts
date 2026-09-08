import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../services/api";
import type { GpuInfo, SystemInfo } from "../types";

export const useSystemStore = defineStore("system", () => {
  const info = ref<SystemInfo | null>(null);
  const loading = ref(false);
  let timer: number | undefined;
  let subscribers = 0;

  const primaryGpu = computed<GpuInfo | null>(() => {
    if (!info.value?.gpu.length) return null;
    return info.value.gpu.find((gpu) => gpu.nvidia) ?? info.value.gpu[0] ?? null;
  });
  const vramUsagePercent = computed(() => {
    const gpu = primaryGpu.value;
    if (!gpu || gpu.memoryUsedBytes === null || !gpu.memoryTotalBytes) return null;
    return Number(((gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100).toFixed(1));
  });

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      info.value = await api.system();
    } catch {
      // Keep the last successful snapshot visible in the topbar.
    } finally {
      loading.value = false;
    }
  }

  function startPolling(intervalMs = 3_000): void {
    subscribers += 1;
    if (timer !== undefined) return;
    void refresh();
    timer = window.setInterval(() => void refresh(), intervalMs);
  }

  function stopPolling(): void {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers > 0 || timer === undefined) return;
    window.clearInterval(timer);
    timer = undefined;
  }

  return { info, loading, primaryGpu, vramUsagePercent, refresh, startPolling, stopPolling };
});
