import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { ProviderRegistry } from "../src/providers/registry";
import type { AIProvider, ChatChunk, ChatRequest, ModelInfo, ProviderStatus, SystemInfo } from "../src/types";
import type { AppConfig } from "../src/config";
import { SystemService } from "../src/services/system";
import { ConversationStore } from "../src/services/conversations";

class TestProvider implements AIProvider {
  readonly id = "lmstudio" as const;
  readonly name = "LM Studio";
  lastRequest: ChatRequest | undefined;
  constructor(private readonly online: boolean) {}
  async health(): Promise<ProviderStatus> { return { id: this.id, name: this.name, online: this.online }; }
  async listModels(): Promise<ModelInfo[]> { return this.online ? [{ provider: this.id, id: "test-model", name: "Test Model", loaded: true }] : []; }
  async listLoadedModels(): Promise<ModelInfo[]> { return this.listModels(); }
  async loadModel(_model: string): Promise<void> {}
  async unloadModel(_model: string): Promise<void> {}
  async *chat(request: ChatRequest): AsyncIterable<ChatChunk> { this.lastRequest = request; yield { text: "hello" }; yield { text: "", done: true }; }
}

class TruncatedStreamProvider extends TestProvider {
  override async *chat(_request: ChatRequest): AsyncIterable<ChatChunk> { yield { text: "hello" }; }
}

class ToolProvider extends TestProvider {
  override async listModels(): Promise<ModelInfo[]> {
    return [{ provider: this.id, id: "test-model", name: "Test Model", loaded: true, capabilities: ["tools"] }];
  }
  override async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.lastRequest = request;
    if (!request.messages.some((message) => message.role === "tool")) {
      yield { text: "", toolCalls: [{ id: "tool-1", name: "get_system_info", arguments: "{}" }] };
      yield { text: "", done: true };
      return;
    }
    yield { text: "The server is healthy." };
    yield { text: "", done: true };
  }
}

class FixedSystemService extends SystemService {
  override async snapshot(): Promise<SystemInfo> {
    return { cpu: { usagePercent: 12, cores: 8 }, memory: { usedBytes: 2, totalBytes: 4, usagePercent: 50 }, gpu: [], nvidia: { present: false, active: false, source: "none" }, operatingSystem: "Test OS", uptimeSeconds: 10, capturedAt: new Date(0).toISOString() };
  }
}

const config: AppConfig = { port: 3000, host: "127.0.0.1", appName: "Test", nodeEnv: "test", lmStudioUrl: null, ollamaUrl: null, corsOrigins: true, dataDir: "/tmp/local-ai-test", authEnabled: false, authPassword: null, updateEnabled: false, updateToken: null, updateBranch: "master", opencodeBridgeEnabled: false, opencodeBridgeToken: null, projectRoot: process.cwd() };
let app: FastifyInstance | undefined;

afterEach(async () => { await app?.close(); app = undefined; });

describe("unified API", () => {
  it("returns discovered models while tolerating an offline provider", async () => {
    app = await buildApp(config, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const response = await app.inject({ method: "GET", url: "/api/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ provider: "lmstudio", id: "test-model", name: "Test Model", loaded: true }]);
  });

  it("returns a coherent health status", async () => {
    app = await buildApp(config, new ProviderRegistry([new TestProvider(false)]), new FixedSystemService());
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", providers: { lmstudio: { online: false } } });
  });

  it("rejects malformed model actions with the public error envelope", async () => {
    app = await buildApp(config, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const response = await app.inject({ method: "POST", url: "/api/models/load", payload: { provider: "unknown", model: "" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: true, code: "VALIDATION_ERROR" });
  });

  it("closes a provider stream with a terminal event when the provider omits done", async () => {
    app = await buildApp(config, new ProviderRegistry([new TruncatedStreamProvider(true)]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { provider: "lmstudio", model: "test-model", messages: [{ role: "user", content: "hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: chunk");
    expect(response.body).toContain('data: {"text":"hello"}');
    expect(response.body).toContain("event: done");
  });

  it("executes only the enabled read-only local tools and continues the model turn", async () => {
    const provider = new ToolProvider(true);
    app = await buildApp(config, new ProviderRegistry([provider]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { provider: "lmstudio", model: "test-model", enableTools: true, messages: [{ role: "user", content: "Check the server" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("The server is healthy.");
    expect(provider.lastRequest?.tools).toHaveLength(3);
    expect(provider.lastRequest?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "tool-1" });
  });

  it("persists the completed assistant message using the conversation id", async () => {
    const dataDir = `/tmp/local-ai-chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    app = await buildApp(config, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService(), undefined, new ConversationStore(dataDir));
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { provider: "lmstudio", model: "test-model", conversationId: "conversation-1", messages: [{ role: "user", content: "Hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const conversations = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toMatchObject([{ id: "conversation-1", messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "hello" }] }]);
  });

  it("exposes the running Git identity", async () => {
    app = await buildApp(config, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const response = await app.inject({ method: "GET", url: "/api/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      shortCommit: expect.stringMatching(/^(unknown|[0-9a-f]{7})$/),
      commit: expect.any(String),
      buildCommit: expect.stringMatching(/^(unknown|[0-9a-f]{7,40})$/),
      buildShortCommit: expect.stringMatching(/^(unknown|[0-9a-f]{7})$/),
      runningCommit: expect.stringMatching(/^(unknown|[0-9a-f]{7,40})$/),
      runningShortCommit: expect.stringMatching(/^(unknown|[0-9a-f]{7})$/),
      bootId: expect.any(String),
      branch: expect.any(String),
      startedAt: expect.any(String),
    });
  });

  it("requires update authorization for a manual service restart", async () => {
    app = await buildApp({ ...config, updateEnabled: true, updateToken: "update-secret" }, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const unauthorized = await app.inject({ method: "POST", url: "/api/service/restart", payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/api/service/restart", payload: { token: "update-secret" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "restart-required", currentVersion: expect.any(String) });
  });
});

describe("OpenCode bridge", () => {
  const bridgeConfig = { ...config, opencodeBridgeEnabled: true, opencodeBridgeToken: "bridge-secret" };

  it("is disabled by default", async () => {
    app = await buildApp(config, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "BRIDGE_DISABLED" } });
  });

  it("lists prefixed models and streams OpenAI-compatible completions", async () => {
    app = await buildApp(bridgeConfig, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const unauthorized = await app.inject({ method: "GET", url: "/v1/models" });
    expect(unauthorized.statusCode).toBe(401);
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer bridge-secret" } });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ object: "list", data: [{ id: "active", object: "model", owned_by: "local-ai" }, { id: "lmstudio/test-model", object: "model", owned_by: "lmstudio" }] });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: { model: "lmstudio/test-model", messages: [{ role: "user", content: "hello" }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"content":"hello"');
    expect(response.body).toContain("data: [DONE]");

    const selected = await app.inject({ method: "POST", url: "/api/bridge/active", payload: { provider: "lmstudio", model: "test-model" } });
    expect(selected.statusCode).toBe(200);
    const activeResponse = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: { model: "active", messages: [{ role: "user", content: "hello" }], stream: false },
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toMatchObject({ model: "active", choices: [{ message: { content: "hello" } }] });
  });

  it("converts multimodal messages and supports non-stream responses", async () => {
    const provider = new TestProvider(true);
    app = await buildApp(bridgeConfig, new ProviderRegistry([provider]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
        ],
        stream: false,
        temperature: 0.2,
        max_completion_tokens: 128,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] });
    expect(provider.lastRequest).toMatchObject({
      model: "test-model",
      systemPrompt: "Be concise",
      temperature: 0.2,
      maxTokens: 128,
      messages: [{ role: "user", content: "What is this?", images: [{ dataUrl: "data:image/png;base64,QUJD", mimeType: "image/png" }] }],
    });
  });

  it("forwards OpenAI tools and tool-result messages and returns tool calls", async () => {
    const provider = new ToolProvider(true);
    app = await buildApp(bridgeConfig, new ProviderRegistry([provider]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "Check the server" }],
        tools: [{
          type: "function",
          function: {
            name: "get_system_info",
            description: "Read system information",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        tool_choice: "auto",
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.lastRequest).toMatchObject({
      tools: [{ type: "function", function: { name: "get_system_info" } }],
      messages: [{ role: "user", content: "Check the server" }],
    });
    expect(response.json()).toMatchObject({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tool-1", type: "function", function: { name: "get_system_info", arguments: "{}" } }],
        },
      }],
    });

    const continuation = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [
          { role: "user", content: "Check the server" },
          { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "get_system_info", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "tool-1", content: "{\"status\":\"ok\"}" },
        ],
        tools: [{ type: "function", function: { name: "get_system_info", parameters: { type: "object" } } }],
        stream: false,
      },
    });
    expect(continuation.statusCode).toBe(200);
    expect(continuation.json()).toMatchObject({ choices: [{ message: { content: "The server is healthy." }, finish_reason: "stop" }] });
    expect(provider.lastRequest?.messages).toEqual([
      { role: "user", content: "Check the server" },
      { role: "assistant", content: "", toolCalls: [{ id: "tool-1", name: "get_system_info", arguments: "{}" }] },
      { role: "tool", content: "{\"status\":\"ok\"}", toolCallId: "tool-1" },
    ]);
  });

  it("streams OpenAI-compatible tool call deltas", async () => {
    app = await buildApp(bridgeConfig, new ProviderRegistry([new ToolProvider(true)]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "Check the server" }],
        tools: [{ type: "function", function: { name: "get_system_info", parameters: { type: "object" } } }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"get_system_info","arguments":"{}"}}]');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
    expect(response.body).toContain("data: [DONE]");
  });

  it("fails clearly when the selected model cannot support tools", async () => {
    app = await buildApp(bridgeConfig, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const unsupportedModel = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "example", parameters: { type: "object" } } }],
      },
    });
    expect(unsupportedModel.statusCode).toBe(400);
    expect(unsupportedModel.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: expect.stringContaining("does not advertise tool support") } });
  });

  it("treats required and named tool_choice as auto for local providers", async () => {
    const provider = new ToolProvider(true);
    app = await buildApp(bridgeConfig, new ProviderRegistry([provider]), new FixedSystemService());
    const requiredChoice = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "example" } }],
        tool_choice: "required",
        stream: false,
      },
    });
    expect(requiredChoice.statusCode).toBe(200);
    expect(provider.lastRequest?.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "example" }) })]);

    const namedChoice = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "example", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "example" } },
        stream: false,
      },
    });
    expect(namedChoice.statusCode).toBe(200);
    expect(provider.lastRequest?.enableTools).toBe(true);
  });

  it("honors tool_choice none as a normal chat request", async () => {
    const provider = new TestProvider(true);
    app = await buildApp(bridgeConfig, new ProviderRegistry([provider]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "example", parameters: { type: "object" } } }],
        tool_choice: "none",
        stream: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.lastRequest?.tools).toBeUndefined();
  });

  it("keeps bridge text requests bounded at the documented per-message limit", async () => {
    app = await buildApp(bridgeConfig, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: { model: "lmstudio/test-model", messages: [{ role: "user", content: "a".repeat(200_000) }], stream: false },
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: { model: "lmstudio/test-model", messages: [{ role: "user", content: "a".repeat(200_001) }], stream: false },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    const aggregateRejected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: {
        model: "lmstudio/test-model",
        messages: [
          { role: "user", content: "a".repeat(180_000) },
          { role: "assistant", content: "b".repeat(180_000) },
          { role: "user", content: "c".repeat(180_000) },
        ],
        stream: false,
      },
    });
    expect(aggregateRejected.statusCode).toBe(400);
    expect(aggregateRejected.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("rejects unprefixed or unknown model ids", async () => {
    app = await buildApp(bridgeConfig, new ProviderRegistry([new TestProvider(true)]), new FixedSystemService());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer bridge-secret" },
      payload: { model: "test-model", messages: [{ role: "user", content: "hello" }] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "MODEL_NOT_FOUND" } });
  });
});
