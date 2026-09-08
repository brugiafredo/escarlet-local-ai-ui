import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as si from "systeminformation";
import type { GpuInfo, SystemInfo } from "../types";

const execFileAsync = promisify(execFile);

interface NvidiaGpuSample {
  name: string;
  usagePercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
}

function mibToBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1024 * 1024 : null;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[N/A]" || trimmed === "N/A") return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNvidiaName(name: string): boolean {
  return /nvidia|geforce|quadro|tesla|rtx|gtx|titan/i.test(name);
}

function gpuActive(gpu: Pick<GpuInfo, "usagePercent" | "memoryUsedBytes">): boolean {
  if (typeof gpu.usagePercent === "number" && gpu.usagePercent >= 1) return true;
  // Idle display adapters often report a few dozen MiB; loaded LLM weights are far larger.
  return typeof gpu.memoryUsedBytes === "number" && gpu.memoryUsedBytes >= 512 * 1024 * 1024;
}

async function readNvidiaSmi(): Promise<NvidiaGpuSample[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 4_000, windowsHide: true, encoding: "utf8" },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line): NvidiaGpuSample[] => {
        const parts = line.split(",").map((part) => part.trim());
        if (parts.length < 4 || !parts[0]) return [];
        const usage = parseOptionalNumber(parts[1]);
        const memoryUsedMiB = parseOptionalNumber(parts[2]);
        const memoryTotalMiB = parseOptionalNumber(parts[3]);
        return [{
          name: parts[0],
          usagePercent: usage === null ? null : Number(usage.toFixed(1)),
          memoryUsedBytes: mibToBytes(memoryUsedMiB),
          memoryTotalBytes: mibToBytes(memoryTotalMiB),
        }];
      });
  } catch {
    return [];
  }
}

function mergeGpuSources(controllers: Awaited<ReturnType<typeof si.graphics>>["controllers"] | undefined, nvidia: NvidiaGpuSample[]): GpuInfo[] {
  const fromControllers: GpuInfo[] = (controllers ?? []).map((controller) => {
    const name = controller.model || controller.name || "Unknown GPU";
    const nvidiaVendor = controller.vendor?.toLowerCase().includes("nvidia") || isNvidiaName(name);
    const memoryUsedBytes = mibToBytes(typeof controller.vramDynamic === "number" ? controller.vramDynamic : undefined);
    const memoryTotalBytes = mibToBytes(typeof controller.vram === "number" ? controller.vram : undefined);
    const usagePercent = null;
    return {
      name,
      vendor: controller.vendor || (nvidiaVendor ? "NVIDIA" : null),
      nvidia: nvidiaVendor,
      memoryUsedBytes,
      memoryTotalBytes,
      usagePercent,
      active: gpuActive({ usagePercent, memoryUsedBytes }),
    };
  });

  if (nvidia.length === 0) return fromControllers;

  if (fromControllers.length === 0) {
    return nvidia.map((sample) => ({
      name: sample.name,
      vendor: "NVIDIA",
      nvidia: true,
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryTotalBytes: sample.memoryTotalBytes,
      usagePercent: sample.usagePercent,
      active: gpuActive(sample),
    }));
  }

  const remainingNvidia = [...nvidia];
  const merged = fromControllers.map((gpu) => {
    if (!gpu.nvidia) return gpu;
    const matchIndex = remainingNvidia.findIndex((sample) => {
      const left = gpu.name.toLowerCase();
      const right = sample.name.toLowerCase();
      return left.includes(right) || right.includes(left) || left.split(/\s+/).some((token) => token.length > 3 && right.includes(token));
    });
    const sample = matchIndex >= 0 ? remainingNvidia.splice(matchIndex, 1)[0] : remainingNvidia.shift();
    if (!sample) return gpu;
    const memoryUsedBytes = sample.memoryUsedBytes ?? gpu.memoryUsedBytes;
    const memoryTotalBytes = sample.memoryTotalBytes ?? gpu.memoryTotalBytes;
    const usagePercent = sample.usagePercent;
    return {
      ...gpu,
      name: sample.name || gpu.name,
      vendor: "NVIDIA",
      nvidia: true,
      memoryUsedBytes,
      memoryTotalBytes,
      usagePercent,
      active: gpuActive({ usagePercent, memoryUsedBytes }),
    };
  });

  for (const sample of remainingNvidia) {
    merged.push({
      name: sample.name,
      vendor: "NVIDIA",
      nvidia: true,
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryTotalBytes: sample.memoryTotalBytes,
      usagePercent: sample.usagePercent,
      active: gpuActive(sample),
    });
  }
  return merged;
}

export class SystemService {
  async snapshot(): Promise<SystemInfo> {
    const [loadResult, memoryResult, graphicsResult, osResult, timeResult, nvidia] = await Promise.all([
      si.currentLoad().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      si.mem().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      si.graphics().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      si.osInfo().then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      Promise.resolve(si.time()).then(
        (value) => ({ status: "fulfilled" as const, value }),
        () => ({ status: "rejected" as const }),
      ),
      readNvidiaSmi(),
    ]);
    const load = loadResult.status === "fulfilled" ? loadResult.value : undefined;
    const memory = memoryResult.status === "fulfilled" ? memoryResult.value : undefined;
    const graphics = graphicsResult.status === "fulfilled" ? graphicsResult.value : undefined;
    const os = osResult.status === "fulfilled" ? osResult.value : undefined;
    const time = timeResult.status === "fulfilled" ? timeResult.value : undefined;
    const gpus = mergeGpuSources(graphics?.controllers, nvidia);
    const totalMemory = memory?.total ?? null;
    const usedMemory = memory ? memory.total - memory.available : null;
    const nvidiaGpus = gpus.filter((gpu) => gpu.nvidia);
    return {
      cpu: {
        usagePercent: load ? Number(load.currentLoad.toFixed(1)) : null,
        cores: load?.cpus?.length ?? null,
      },
      memory: {
        usedBytes: usedMemory,
        totalBytes: totalMemory,
        usagePercent: totalMemory && usedMemory !== null ? Number(((usedMemory / totalMemory) * 100).toFixed(1)) : null,
      },
      gpu: gpus,
      nvidia: {
        present: nvidiaGpus.length > 0 || nvidia.length > 0,
        active: nvidiaGpus.some((gpu) => gpu.active) || nvidia.some((sample) => gpuActive(sample)),
        source: nvidia.length > 0 ? "nvidia-smi" : nvidiaGpus.length > 0 ? "system" : "none",
      },
      operatingSystem: os ? [os.distro, os.release].filter(Boolean).join(" ") : "Unknown",
      uptimeSeconds: time?.uptime ?? null,
      capturedAt: new Date().toISOString(),
    };
  }
}
