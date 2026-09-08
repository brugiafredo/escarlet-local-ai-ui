export type ProviderId = "lmstudio" | "ollama";
export type ModelCapability = "vision" | "tools" | "reasoning" | "embedding";
export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ChatImage {
  dataUrl: string;
  mimeType: ImageMimeType;
  name?: string | undefined;
  size?: number | undefined;
}

export interface ModelInfo {
  provider: ProviderId;
  id: string;
  name: string;
  loaded: boolean;
  capabilities?: ModelCapability[];
  contextLength?: number;
  size?: number;
  deletable?: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  online: boolean;
  message?: string;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: ChatImage[] | undefined;
  toolCalls?: ChatToolCall[] | undefined;
  toolCallId?: string | undefined;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  conversationId?: string | undefined;
  systemPrompt?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  contextLength?: number | undefined;
  tools?: ChatToolDefinition[] | undefined;
  enableTools?: boolean | undefined;
}

export interface ChatChunk {
  text: string;
  done?: boolean;
  toolCalls?: ChatToolCall[];
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly name: string;
  health(): Promise<ProviderStatus>;
  listModels(): Promise<ModelInfo[]>;
  listLoadedModels(): Promise<ModelInfo[]>;
  loadModel(model: string, contextLength?: number): Promise<void>;
  unloadModel(model: string): Promise<void>;
  downloadModel?(model: string): Promise<void>;
  deleteModel?(model: string): Promise<void>;
  chat(request: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface Conversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  systemPrompt: string;
  parameters: { temperature: number; maxTokens: number; contextLength: number };
  createdAt: string;
  updatedAt: string;
  ownerId?: string;
  visibility?: "private" | "shared";
  sharedWith?: string[];
}

export interface GpuInfo {
  name: string;
  vendor: string | null;
  nvidia: boolean;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  usagePercent: number | null;
  /** True when utilisation or VRAM suggests the GPU is doing meaningful work. */
  active: boolean;
}

export interface SystemInfo {
  cpu: {
    usagePercent: number | null;
    cores: number | null;
  };
  memory: {
    usedBytes: number | null;
    totalBytes: number | null;
    usagePercent: number | null;
  };
  gpu: GpuInfo[];
  nvidia: {
    present: boolean;
    active: boolean;
    source: "nvidia-smi" | "system" | "none";
  };
  operatingSystem: string;
  uptimeSeconds: number | null;
  capturedAt: string;
}
