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
  /** Whether the provider permits removing this installed model. */
  deletable?: boolean;
  contextLength?: number;
  size?: number;
}

export type ModelOperation = "load" | "unload" | "download" | "delete";

export interface AuthUser {
  id: string;
  displayName?: string;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  user?: AuthUser;
}

export interface UpdateStatus {
  enabled: boolean;
  state: "idle" | "checking" | "available" | "updating" | "restart-required" | "failed" | "unavailable";
  currentVersion: string;
  latestVersion?: string;
  buildVersion?: string;
  message?: string;
  checkedAt?: string;
  releaseUrl?: string;
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

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  online: boolean;
  message?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: ChatImage[];
}

export interface ConversationParameters {
  temperature: number;
  maxTokens: number;
  contextLength: number;
}

export interface Conversation {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  systemPrompt: string;
  parameters: ConversationParameters;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  conversationId?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  contextLength?: number;
  enableTools?: boolean;
}

export interface ChatStreamChunk {
  text: string;
  done?: boolean;
}

export interface GpuInfo {
  name: string;
  vendor: string | null;
  nvidia: boolean;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  usagePercent: number | null;
  active: boolean;
}

export interface SystemInfo {
  cpu: { usagePercent: number | null; cores: number | null };
  memory: { usedBytes: number | null; totalBytes: number | null; usagePercent: number | null };
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

export interface ApiErrorShape {
  error: true;
  code: string;
  message: string;
}
