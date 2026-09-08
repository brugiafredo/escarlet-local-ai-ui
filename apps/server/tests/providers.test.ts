import { describe, expect, it } from "vitest";
import { LMStudioProvider, nativeInput, normalizeLMStudioModels } from "../src/providers/lmstudio";
import { normalizeOllamaModels, ollamaMessages, OllamaProvider, parseOllamaNdjson } from "../src/providers/ollama";

describe("provider model normalization", () => {
  it("normalizes LM Studio v1 metadata and loaded instances", () => {
    const models = normalizeLMStudioModels({
      models: [{
        id: "local/model",
        display_name: "Local Model",
        loaded_instances: [{ instance_id: "instance-1" }],
        context_length: 8192,
      }],
    });
    expect(models).toEqual([{ provider: "lmstudio", id: "local/model", name: "Local Model", loaded: true, deletable: true, contextLength: 8192, instanceId: "instance-1" }]);
  });

  it("supports the current LM Studio v1 key field", () => {
    expect(normalizeLMStudioModels({ models: [{ key: "qwen/qwen3.5-27b", display_name: "Qwen 3.5 27B" }] })).toEqual([
      { provider: "lmstudio", id: "qwen/qwen3.5-27b", name: "Qwen 3.5 27B", loaded: false, deletable: true },
    ]);
  });

  it("normalizes vision, tool, and reasoning capabilities from LM Studio", () => {
    expect(normalizeLMStudioModels({ models: [{ key: "google/gemma-4", capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ["on"] } } }] })).toEqual([
      { provider: "lmstudio", id: "google/gemma-4", name: "google/gemma-4", loaded: false, deletable: true, capabilities: ["vision", "tools", "reasoning"] },
    ]);
  });

  it("merges Ollama installed and running model lists", () => {
    const models = normalizeOllamaModels(
      { models: [{ name: "granite:latest", size: 1024 }] },
      { models: [{ name: "granite:latest" }] },
    );
    expect(models[0]).toMatchObject({ provider: "ollama", id: "granite:latest", loaded: true, size: 1024 });
  });

  it("normalizes Ollama capabilities returned by /api/show", () => {
    const models = normalizeOllamaModels(
      { models: [{ name: "gemma4", size: 1024 }] },
      { models: [] },
      { gemma4: { capabilities: ["completion", "vision", "thinking"] } },
    );
    expect(models[0]).toMatchObject({ capabilities: ["vision", "reasoning"] });
  });

  it("maps image data URLs to each provider's native image payload", () => {
    const request = {
      provider: "ollama" as const,
      model: "gemma4",
      messages: [{ role: "user" as const, content: "What is this?", images: [{ dataUrl: "data:image/png;base64,QUJD", mimeType: "image/png" as const }] }],
    };
    expect(ollamaMessages(request)).toEqual([{ role: "user", content: "What is this?", images: ["QUJD"] }]);
    expect(nativeInput({ ...request, provider: "lmstudio" })).toEqual([
      { type: "message", content: "User: What is this?" },
      { type: "image", data_url: "data:image/png;base64,QUJD" },
    ]);
  });

  it("parses Ollama content and thinking chunks and surfaces stream errors", async () => {
    const response = new Response([
      JSON.stringify({ message: { role: "assistant", thinking: "Let me think" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "Hola" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true }),
    ].join("\n"));
    const chunks: Array<{ text: string; done?: boolean }> = [];
    for await (const chunk of parseOllamaNdjson(response)) chunks.push(chunk);
    expect(chunks).toEqual([{ text: "Let me think" }, { text: "Hola" }, { text: "", done: true }]);

    await expect(async () => {
      for await (const _chunk of parseOllamaNdjson(new Response(JSON.stringify({ error: "model failed" })))) {
        // The iterator should reject before yielding a misleading empty answer.
      }
    }).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: "model failed" });
  });
});

describe("offline provider handling", () => {
  it("reports an unconfigured LM Studio as offline without throwing from health", async () => {
    const status = await new LMStudioProvider(null).health();
    expect(status.online).toBe(false);
    await expect(new LMStudioProvider(null).listModels()).rejects.toMatchObject({ code: "PROVIDER_OFFLINE" });
  });

  it("reports an unconfigured Ollama as offline", async () => {
    const status = await new OllamaProvider(null).health();
    expect(status).toMatchObject({ id: "ollama", online: false });
  });

  it("falls back to the OpenAI-compatible LM Studio chat endpoint after a 404", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (urls.length === 1) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"Hola"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" mundo"}}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    try {
      const chunks = [];
      for await (const chunk of new LMStudioProvider("http://lmstudio.test").chat({
        provider: "lmstudio",
        model: "local/model",
        messages: [{
          role: "user",
          content: "Describe this",
          images: [{ dataUrl: "data:image/png;base64,QUJD", mimeType: "image/png" }],
        }],
        systemPrompt: "Be concise",
        temperature: 0.2,
        maxTokens: 128,
      })) {
        chunks.push(chunk);
      }

      expect(urls).toEqual([
        "http://lmstudio.test/api/v1/chat",
        "http://lmstudio.test/v1/chat/completions",
      ]);
      expect(JSON.parse(bodies[1])).toMatchObject({
        model: "local/model",
        stream: true,
        temperature: 0.2,
        max_tokens: 128,
        messages: [
          { role: "system", content: "Be concise" },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            ],
          },
        ],
      });
      expect(chunks).toEqual([{ text: "Hola" }, { text: " mundo" }, { text: "", done: true }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends read-only tools to Ollama and normalizes returned tool calls", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ message: { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "get_system_info", arguments: {} } }] } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const chunks = [];
      for await (const chunk of new OllamaProvider("http://ollama.test").chat({
        provider: "ollama",
        model: "qwen3",
        messages: [{ role: "user", content: "Check the server" }],
        tools: [{ type: "function", function: { name: "get_system_info", description: "Read system info", parameters: { type: "object" } } }],
      })) {
        chunks.push(chunk);
      }
      expect(JSON.parse(requestBody)).toMatchObject({ model: "qwen3", stream: false, tools: [{ type: "function", function: { name: "get_system_info" } }] });
      expect(chunks).toEqual([{ text: "", toolCalls: [{ id: "call-1", name: "get_system_info", arguments: "{}" }] }, { text: "", done: true }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses LM Studio's OpenAI-compatible endpoint for read-only tools", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-2", type: "function", function: { name: "list_local_models", arguments: "{}" } }] } }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const chunks = [];
      for await (const chunk of new LMStudioProvider("http://lmstudio.test").chat({
        provider: "lmstudio",
        model: "local/model",
        messages: [{ role: "user", content: "List models" }],
        tools: [{ type: "function", function: { name: "list_local_models", description: "List models", parameters: { type: "object" } } }],
      })) {
        chunks.push(chunk);
      }
      expect(requestUrl).toBe("http://lmstudio.test/v1/chat/completions");
      expect(JSON.parse(requestBody)).toMatchObject({ model: "local/model", stream: false, tool_choice: "auto", tools: [{ type: "function", function: { name: "list_local_models" } }] });
      expect(chunks).toEqual([{ text: "", toolCalls: [{ id: "call-2", name: "list_local_models", arguments: "{}" }] }, { text: "", done: true }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("downloads an LM Studio model and waits for the job to complete", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(JSON.stringify({ job_id: "job_1", status: "downloading", total_size_bytes: 100 }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ job_id: "job_1", status: "completed", downloaded_bytes: 100, total_size_bytes: 100 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await new LMStudioProvider("http://lmstudio.test").downloadModel("ibm/granite-4-micro");
      expect(urls).toEqual([
        "http://lmstudio.test/api/v1/models/download",
        "http://lmstudio.test/api/v1/models/download/status/job_1",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
