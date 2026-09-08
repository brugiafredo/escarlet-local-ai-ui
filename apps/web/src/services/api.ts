import type { ApiErrorShape, AuthStatus, ChatRequest, ChatStreamChunk, Conversation, ModelInfo, ProviderStatus, ServerVersion, SystemInfo, UpdateStatus } from "../types";

const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "REQUEST_FAILED", status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("The Escarlet Local AI UI server is unreachable", "SERVER_OFFLINE", 503);
  }
  const payload: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = payload as Partial<ApiErrorShape> | undefined;
    throw new ApiError(error?.message || "The request failed", error?.code || "REQUEST_FAILED", response.status);
  }
  return payload as T;
}

export const api = {
  providers: () => request<ProviderStatus[]>("/api/providers"),
  health: () => request<{ status: string; providers: Record<ProviderStatus["id"], { online: boolean; message?: string }> }>("/api/health"),
  models: () => request<ModelInfo[]>("/api/models"),
  loadModel: (provider: ModelInfo["provider"], model: string, contextLength?: number) => request<{ ok: true }>("/api/models/load", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model, ...(contextLength ? { contextLength } : {}) }),
  }),
  unloadModel: (provider: ModelInfo["provider"], model: string) => request<{ ok: true }>("/api/models/unload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model }),
  }),
  downloadModel: (provider: ModelInfo["provider"], model: string) => request<{ ok: true; model?: string }>("/api/models/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model }),
  }),
  deleteModel: (provider: ModelInfo["provider"], model: string) => request<{ ok: true }>("/api/models/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model }),
  }),
  setBridgeActive: (provider: ModelInfo["provider"], model: string) => request<{ provider: ModelInfo["provider"]; model: string }>("/api/bridge/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model }),
  }),
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (password: string) => request<AuthStatus>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  conversations: async () => {
    const payload = await request<Conversation[] | { conversations?: Conversation[] }>("/api/conversations");
    return Array.isArray(payload) ? payload : (payload.conversations ?? []);
  },
  saveConversation: (conversation: Conversation) => request<Conversation>("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(conversation),
  }),
  deleteConversation: (id: string) => request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updateStatus: () => request<UpdateStatus>("/api/update/status"),
  checkForUpdate: (token?: string) => request<UpdateStatus>("/api/update/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(token ? { body: JSON.stringify({ token }) } : { body: JSON.stringify({}) }),
  }),
  triggerUpdate: (token?: string) => request<UpdateStatus>("/api/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(token ? { body: JSON.stringify({ token }) } : { body: JSON.stringify({}) }),
  }),
  restartService: (token?: string) => request<UpdateStatus>("/api/service/restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(token ? { body: JSON.stringify({ token }) } : { body: JSON.stringify({}) }),
  }),
  version: () => request<ServerVersion>("/api/version"),
  system: () => request<SystemInfo>("/api/system"),
  async *chat(input: ChatRequest): AsyncIterable<ChatStreamChunk> {
    let response: Response;
    try {
      response = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(input),
      });
    } catch {
      throw new ApiError("The Escarlet Local AI UI server is unreachable", "SERVER_OFFLINE", 503);
    }
    if (!response.ok || !response.body) {
      const payload: unknown = await response.json().catch(() => undefined);
      const error = payload as Partial<ApiErrorShape> | undefined;
      throw new ApiError(error?.message || "Unable to start the chat", error?.code || "REQUEST_FAILED", response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "chunk";
    let dataLines: string[] = [];
    const dispatch = (): ChatStreamChunk | undefined => {
      if (dataLines.length === 0) {
        eventName = "chunk";
        return undefined;
      }
      const raw = dataLines.join("\n");
      dataLines = [];
      const currentEvent = eventName;
      eventName = "chunk";
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new ApiError("The server returned an invalid chat event. Check the server log and try again.", "PROVIDER_ERROR", 502);
      }
      if (currentEvent === "error") {
        const error = payload as Partial<ApiErrorShape>;
        throw new ApiError(error.message || "The provider request failed", error.code || "PROVIDER_ERROR", 502);
      }
      const chunk = payload as ChatStreamChunk;
      return { text: typeof chunk.text === "string" ? chunk.text : "", ...(currentEvent === "done" || chunk.done ? { done: true } : {}) };
    };
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const lines = buffer.split(/\r?\n/);
      buffer = result.done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line) {
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
      if (result.done) {
        const chunk = dispatch();
        if (chunk) {
          yield chunk;
        }
        break;
      }
    }
  },
};
