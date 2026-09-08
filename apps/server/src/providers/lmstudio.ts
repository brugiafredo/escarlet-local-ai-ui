import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError, ProviderOfflineError } from "../errors";
import { fetchWithTimeout, isRecord, numberValue, readJson, stringValue } from "../http";
import type { AIProvider, ChatChunk, ChatRequest, ChatToolCall, ModelCapability, ModelInfo, ProviderStatus } from "../types";

const execFileAsync = promisify(execFile);
const DOWNLOAD_POLL_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveLmStudioModelsDir(): Promise<string> {
  const configured = process.env.LM_STUDIO_MODELS_DIR?.trim();
  if (configured) return path.resolve(configured);
  const home = os.homedir();
  const settingsPath = path.join(home, ".lmstudio", "settings.json");
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(raw) as unknown;
    if (isRecord(settings)) {
      const folder = stringValue(settings.downloadsFolder) ?? stringValue(settings.modelsPath) ?? stringValue(settings.models_path);
      if (folder) return path.resolve(folder);
    }
  } catch {
    // Fall back to the default LM Studio models folder.
  }
  return path.join(home, ".lmstudio", "models");
}

function modelDiskPath(modelsDir: string, modelKey: string): string {
  const withoutVariant = modelKey.split("@")[0] ?? modelKey;
  const segments = withoutVariant.split(/[/\\]+/).map((segment) => segment.trim()).filter((segment) => segment && segment !== "." && segment !== "..");
  if (segments.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Enter a valid LM Studio model key", 400);
  }
  const root = path.resolve(modelsDir);
  const target = path.resolve(root, ...segments);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new AppError("VALIDATION_ERROR", "Refusing to delete a path outside the LM Studio models folder", 400);
  }
  return target;
}

async function removeWithLmsCli(model: string): Promise<boolean> {
  try {
    await execFileAsync("lms", ["remove", model, "-y"], { timeout: 120_000, windowsHide: true, encoding: "utf8" });
    return true;
  } catch {
    try {
      await execFileAsync("lms", ["rm", model, "-y"], { timeout: 120_000, windowsHide: true, encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }
}

async function removeEmptyParents(startPath: string, stopAt: string): Promise<void> {
  let current = path.dirname(startPath);
  const root = path.resolve(stopAt);
  while (current.startsWith(root) && current !== root) {
    try {
      const entries = await fs.readdir(current);
      if (entries.length > 0) return;
      await fs.rmdir(current);
      current = path.dirname(current);
    } catch {
      return;
    }
  }
}

interface InternalModel extends ModelInfo {
  instanceId?: string;
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return [];
  }
  const candidates = [payload.models, payload.data, payload.results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function nestedArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function firstInstanceId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstInstanceId(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    return stringValue(value.instance_id) ?? stringValue(value.instanceId) ?? stringValue(value.id);
  }
  return undefined;
}

function hasLoadedState(record: Record<string, unknown>, instances: unknown[]): boolean {
  if (instances.length > 0) {
    return true;
  }
  if (record.loaded === true || record.is_loaded === true) {
    return true;
  }
  const state = stringValue(record.state)?.toLowerCase();
  return state === "loaded" || state === "ready" || state === "running";
}

function modelCapabilities(record: Record<string, unknown>): ModelCapability[] {
  const capabilities: ModelCapability[] = [];
  const add = (capability: ModelCapability): void => {
    if (!capabilities.includes(capability)) capabilities.push(capability);
  };
  const raw = record.capabilities;
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (value === "vision" || value === "image_input") add("vision");
      if (value === "tool_use" || value === "tools") add("tools");
      if (value === "reasoning" || value === "thinking") add("reasoning");
      if (value === "embedding") add("embedding");
    }
  } else if (isRecord(raw)) {
    if (raw.vision === true) add("vision");
    if (raw.trained_for_tool_use === true || raw.trainedForToolUse === true) add("tools");
    if (isRecord(raw.reasoning) || raw.reasoning === true) add("reasoning");
  }
  if (record.type === "embedding") add("embedding");
  if (record.type === "vlm") add("vision");
  return capabilities;
}

export function normalizeLMStudioModels(payload: unknown): InternalModel[] {
  return arrayFromPayload(payload).flatMap((item): InternalModel[] => {
    if (!isRecord(item)) {
      return [];
    }
    // LM Studio v1 calls the stable model identifier `key`; older versions used id/model_key.
    const id = stringValue(item.key) ?? stringValue(item.id) ?? stringValue(item.model_key) ?? stringValue(item.model);
    if (!id) {
      return [];
    }
    const instances = nestedArray(item, ["loaded_instances", "loadedInstances", "instances"]);
    const instanceId = firstInstanceId(instances) ?? stringValue(item.instance_id) ?? stringValue(item.instanceId);
    const model: InternalModel = {
      provider: "lmstudio",
      id,
      name: stringValue(item.display_name) ?? stringValue(item.name) ?? id,
      loaded: hasLoadedState(item, instances),
      deletable: true,
    };
    const capabilities = modelCapabilities(item);
    if (capabilities.length > 0) model.capabilities = capabilities;
    const contextLength = numberValue(item.context_length) ?? numberValue(item.max_context_length);
    const size = numberValue(item.size) ?? numberValue(item.size_bytes);
    if (contextLength !== undefined) {
      model.contextLength = contextLength;
    }
    if (size !== undefined) {
      model.size = size;
    }
    if (instanceId) {
      model.instanceId = instanceId;
    }
    return [model];
  });
}

type NativeInputItem = { type: "message"; content: string } | { type: "image"; data_url: string };

export function nativeInput(request: ChatRequest): string | NativeInputItem[] {
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      message,
      content: `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
    }));
  if (!messages.some(({ message }) => (message.images?.length ?? 0) > 0)) {
    return messages.map(({ content }) => content).join("\n\n");
  }
  return [
    { type: "message", content: messages.map(({ content }) => content).join("\n\n") },
    ...messages.flatMap(({ message }) => (message.images ?? []).map((image) => ({ type: "image" as const, data_url: image.dataUrl }))),
  ];
}

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function openAiMessages(request: ChatRequest): OpenAIMessage[] {
  const messages = request.messages.map((message): OpenAIMessage => {
    if (message.role === "tool") {
      return { role: "tool", content: message.content, ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}) };
    }
    if (!message.images?.length) {
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        } : {}),
      };
    }
    return {
      role: message.role,
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
      ],
    };
  });
  if (request.systemPrompt?.trim() && !messages.some((message) => message.role === "system")) {
    messages.unshift({ role: "system", content: request.systemPrompt.trim() });
  }
  return messages;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    return typeof item.text === "string" ? [item.text] : [];
  }).join("");
  return text || undefined;
}

function serializeToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function toolCallsFromOpenAiPayload(payload: unknown): ChatToolCall[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return [];
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message) || !Array.isArray(firstChoice.message.tool_calls)) return [];
  return firstChoice.message.tool_calls.flatMap((value, index): ChatToolCall[] => {
    if (!isRecord(value)) return [];
    const fn = isRecord(value.function) ? value.function : value;
    const name = stringValue(fn.name);
    if (!name) return [];
    return [{
      id: stringValue(value.id) ?? `lmstudio-tool-${index + 1}`,
      name,
      arguments: serializeToolArguments(fn.arguments),
    }];
  });
}

async function* parseLMStudioToolResponse(response: Response): AsyncIterable<ChatChunk> {
  const payload = await readJson(response);
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new AppError("PROVIDER_ERROR", "LM Studio returned an invalid tool response", 502);
  }
  const firstChoice = payload.choices[0];
  const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
  const text = message ? contentText(message.content) : undefined;
  const toolCalls = toolCallsFromOpenAiPayload(payload);
  if (text) yield { text };
  if (toolCalls.length > 0) yield { text: "", toolCalls };
  yield { text: "", done: true };
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textFromEvent(value: unknown, eventName: string): string | undefined {
  if (typeof value === "string") {
    return eventName.includes("message") || eventName.includes("delta") ? value : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = [value.text, value.content, value.response];
  for (const candidate of direct) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  const delta = value.delta;
  if (isRecord(delta)) {
    return textValue(delta.content) ?? textValue(delta.text);
  }
  const message = value.message;
  if (isRecord(message)) {
    return textValue(message.content) ?? textValue(message.text);
  }
  const output = value.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) continue;
      const content = textValue(item.content) ?? textValue(item.text);
      if (content) return content;
    }
  }
  const choices = value.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const choiceDelta = first.delta;
      if (isRecord(choiceDelta)) {
        return textValue(choiceDelta.content) ?? textValue(choiceDelta.text);
      }
      const choiceMessage = first.message;
      if (isRecord(choiceMessage)) {
        return textValue(choiceMessage.content);
      }
    }
  }
  return undefined;
}

async function* parseNamedSse(response: Response): AsyncIterable<ChatChunk> {
  if (!response.body) {
    throw new AppError("PROVIDER_ERROR", "LM Studio returned an empty stream", 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = (): ChatChunk | undefined => {
    if (dataLines.length === 0) {
      eventName = "message";
      return undefined;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const currentEvent = eventName;
    eventName = "message";
    if (raw === "[DONE]") {
      return { text: "", done: true };
    }
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return raw ? { text: raw } : undefined;
    }
    const text = textFromEvent(parsed, currentEvent);
    const done = currentEvent.includes("end") || currentEvent.includes("complete") || (isRecord(parsed) && parsed.done === true);
    if (text || done) {
      return { text: text ?? "", ...(done ? { done: true } : {}) };
    }
    return undefined;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") {
        const chunk = dispatch();
        if (chunk) {
          yield chunk;
        }
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (buffer.startsWith("data:")) {
    dataLines.push(buffer.slice(5).trimStart());
  }
  const finalChunk = dispatch();
  if (finalChunk) {
    yield finalChunk;
  }
}

export class LMStudioProvider implements AIProvider {
  readonly id = "lmstudio" as const;
  readonly name = "LM Studio";
  private readonly baseUrl: string | null;

  constructor(baseUrl: string | null) {
    this.baseUrl = baseUrl;
  }

  private requireUrl(): string {
    if (!this.baseUrl) {
      throw new ProviderOfflineError(this.name);
    }
    return this.baseUrl;
  }

  async health(): Promise<ProviderStatus> {
    if (!this.baseUrl) {
      return { id: this.id, name: this.name, online: false, message: "LM_STUDIO_URL is not configured" };
    }
    try {
      let response = await fetchWithTimeout(`${this.baseUrl}/api/v1/models`, {}, 4_000);
      if (response.status === 404) {
        response = await fetchWithTimeout(`${this.baseUrl}/api/v0/models`, {}, 4_000);
      }
      if (!response.ok) {
        return { id: this.id, name: this.name, online: false, message: `Provider returned HTTP ${response.status}` };
      }
      return { id: this.id, name: this.name, online: true };
    } catch {
      return { id: this.id, name: this.name, online: false, message: "LM Studio is not reachable" };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const baseUrl = this.requireUrl();
    let response = await fetchWithTimeout(`${baseUrl}/api/v1/models`);
    if (response.status === 404) {
      response = await fetchWithTimeout(`${baseUrl}/api/v0/models`);
    }
    const payload = await readJson(response);
    return normalizeLMStudioModels(payload);
  }

  async listLoadedModels(): Promise<ModelInfo[]> {
    const models = await this.listModels();
    return models.filter((model) => model.loaded);
  }

  async loadModel(model: string, contextLength?: number): Promise<void> {
    const baseUrl = this.requireUrl();
    const body: Record<string, unknown> = { model };
    if (contextLength !== undefined) {
      body.context_length = contextLength;
    }
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 120_000);
    await readJson(response);
  }

  async unloadModel(model: string): Promise<void> {
    const baseUrl = this.requireUrl();
    const models = await this.listModels() as InternalModel[];
    const loaded = models.find((candidate) => candidate.id === model && candidate.loaded);
    if (!loaded) {
      throw new AppError("MODEL_NOT_LOADED", `${model} is not loaded in LM Studio`, 409);
    }
    if (!loaded.instanceId) {
      throw new AppError("PROVIDER_ERROR", "LM Studio did not report an instance id for the loaded model", 502);
    }
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/models/unload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance_id: loaded.instanceId }),
    }, 120_000);
    await readJson(response);
  }

  async downloadModel(model: string): Promise<void> {
    const baseUrl = this.requireUrl();
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/models/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }, 60_000);
    const payload = await readJson(response);
    if (!isRecord(payload)) {
      throw new AppError("PROVIDER_ERROR", "LM Studio returned an invalid download response", 502);
    }
    const status = stringValue(payload.status);
    if (status === "already_downloaded" || status === "completed") {
      return;
    }
    const jobId = stringValue(payload.job_id) ?? stringValue(payload.jobId);
    if (!jobId) {
      if (status === "failed") {
        throw new AppError("PROVIDER_ERROR", "LM Studio failed to start the model download", 502);
      }
      return;
    }
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const statusResponse = await fetchWithTimeout(`${baseUrl}/api/v1/models/download/status/${encodeURIComponent(jobId)}`, {}, 15_000);
      const statusPayload = await readJson(statusResponse);
      if (!isRecord(statusPayload)) {
        throw new AppError("PROVIDER_ERROR", "LM Studio returned an invalid download status", 502);
      }
      const jobStatus = stringValue(statusPayload.status);
      if (jobStatus === "completed" || jobStatus === "already_downloaded") {
        return;
      }
      if (jobStatus === "failed") {
        const detail = stringValue(statusPayload.error) ?? stringValue(statusPayload.message) ?? "LM Studio download failed";
        throw new AppError("PROVIDER_ERROR", detail, 502);
      }
      await sleep(DOWNLOAD_POLL_MS);
    }
    throw new AppError("PROVIDER_ERROR", `Timed out while downloading ${model} from LM Studio`, 504);
  }

  async deleteModel(model: string): Promise<void> {
    const models = await this.listModels() as InternalModel[];
    const target = models.find((candidate) => candidate.id === model);
    if (!target) {
      throw new AppError("MODEL_NOT_FOUND", `${model} was not found in LM Studio`, 404);
    }
    if (target.loaded) {
      await this.unloadModel(model);
    }
    if (await removeWithLmsCli(model)) {
      return;
    }
    const modelsDir = await resolveLmStudioModelsDir();
    const diskPath = modelDiskPath(modelsDir, model);
    try {
      await fs.access(diskPath);
    } catch {
      throw new AppError("MODEL_NOT_FOUND", `Could not find local files for ${model} under ${modelsDir}`, 404);
    }
    await fs.rm(diskPath, { recursive: true, force: true });
    await removeEmptyParents(diskPath, modelsDir);
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    const baseUrl = this.requireUrl();
    if (request.tools?.length) {
      const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: openAiMessages(request),
          stream: false,
          tools: request.tools,
          tool_choice: "auto",
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
      }, 120_000);
      if (!response.ok) {
        await readJson(response);
      }
      yield* parseLMStudioToolResponse(response);
      return;
    }
    const body: Record<string, unknown> = {
      model: request.model,
      input: nativeInput(request),
      stream: true,
    };
    if (request.systemPrompt?.trim()) {
      body.system_prompt = request.systemPrompt.trim();
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_output_tokens = request.maxTokens;
    }
    let response = await fetchWithTimeout(`${baseUrl}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    }, 120_000);
    if (response.status === 404) {
      const compatibilityBody: Record<string, unknown> = {
        model: request.model,
        messages: openAiMessages(request),
        stream: true,
      };
      if (request.temperature !== undefined) {
        compatibilityBody.temperature = request.temperature;
      }
      if (request.maxTokens !== undefined) {
        compatibilityBody.max_tokens = request.maxTokens;
      }
      response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(compatibilityBody),
      }, 120_000);
    }
    if (!response.ok) {
      await readJson(response);
    }
    yield* parseNamedSse(response);
  }
}
