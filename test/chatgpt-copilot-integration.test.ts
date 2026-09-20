import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotProvider, resetCopilotModelCache } from "../src/llm/copilot.js";
import { codexProvider, resetCodexModelCache } from "../src/llm/codex.js";
import { getProvider } from "../src/llm/router.js";
import { normalizeProvider } from "../src/llm/provider.js";
import { encodeCodexKey } from "../src/llm/codex-auth.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { CompletionRequest } from "../src/types.js";

const COPILOT_GITHUB_TOKEN = "ghu_copilotintegrationtest0000000";
const CODEX_ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const CODEX_ACCESS_TOKEN = "acc-codex-integration-token-value";

function codexKey(residency?: string): string {
  return encodeCodexKey({
    accessToken: CODEX_ACCESS_TOKEN,
    accountId: CODEX_ACCOUNT_ID,
    ...(residency ? { residency } : {}),
  });
}

function copilotTokenExchangeResponse() {
  return new Response(
    JSON.stringify({
      token: "tid=copilot-token-test;exp=9999999999;sku=test",
      expires_at: 9999999999,
      refresh_in: 1500,
      endpoints: { api: "https://api.githubcopilot.com" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("ChatGPT Subscription and GitHub Copilot integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetCopilotModelCache();
    resetCodexModelCache();
  });

  it("exposes expected display names and aliases", () => {
    expect(getProvider("codex").displayName).toBe("Chatgpt Subscription(free/go/plus/pro)");
    expect(getProvider("copilot").displayName).toBe("Github Copilot");

    expect(normalizeProvider("chatgpt")).toBe("codex");
    expect(normalizeProvider("chatgpt-subscription")).toBe("codex");
    expect(normalizeProvider("Chatgpt Subscription(free/go/plus/pro)")).toBe("codex");
    expect(normalizeProvider("github copilot")).toBe("copilot");
    expect(normalizeProvider("copilot")).toBe("copilot");
  });

  it("routes Claude models on Copilot to Anthropic messages protocol", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        return copilotTokenExchangeResponse();
      }
      if (url.endsWith("/v1/messages")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model).toBe("claude-sonnet-4.5");
        expect(body.messages).toBeDefined();
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello from Claude on Copilot" }],
            usage: {
              input_tokens: 50,
              output_tokens: 15,
              cache_read_input_tokens: 20,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request: CompletionRequest = {
      model: "claude-sonnet-4.5",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
      tools: [
        {
          name: "test_tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      ],
    };

    const result = await withSessionAffinity("session-copilot-claude-42", () =>
      copilotProvider.complete(request, { apiKey: COPILOT_GITHUB_TOKEN }),
    );

    expect(result.text).toBe("Hello from Claude on Copilot");
    expect(result.usage?.cachedPromptTokens).toBe(20);

    const messagesCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/v1/messages"),
    );
    expect(messagesCall).toBeDefined();
    const headers = new Headers(messagesCall![1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer tid=copilot-token-test;exp=9999999999;sku=test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("OpenAI-Intent")).toBe("conversation-edits");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    expect(headers.get("X-Interaction-Id")).toBe("session-copilot-claude-42");
  });

  it("routes GPT models on Copilot to chat completions without max_tokens", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        return copilotTokenExchangeResponse();
      }
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.model).toBe("gpt-4o");
        expect(body).not.toHaveProperty("max_tokens");
        expect(body).not.toHaveProperty("max_completion_tokens");
        return new Response(
          JSON.stringify({
            id: "chatcmpl_test",
            object: "chat.completion",
            choices: [
              {
                message: { role: "assistant", content: "Hello from GPT on Copilot" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 15 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request: CompletionRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = await copilotProvider.complete(request, {
      apiKey: COPILOT_GITHUB_TOKEN,
    });
    expect(result.text).toBe("Hello from GPT on Copilot");
    expect(result.usage?.cachedPromptTokens).toBe(15);
  });

  it("omits parallel_tool_calls and sends prompt_cache_key in Codex responses requests", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty("parallel_tool_calls");
        expect(body.prompt_cache_key).toMatch(/^clai-[0-9a-f]{40}$/);
        expect(body.tools).toBeDefined();

        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${CODEX_ACCESS_TOKEN}`);
        expect(headers.get("chatgpt-account-id")).toBe(CODEX_ACCOUNT_ID);
        expect(headers.get("session-id")).toBe("session-codex-affinity-99");
        expect(headers.get("x-openai-internal-codex-residency")).toBe("eu");

        return new Response(
          JSON.stringify({
            id: "resp_test",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Codex responses success" }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 25,
              input_tokens_details: { cached_tokens: 40 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request: CompletionRequest = {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Codex system prompt" },
        { role: "user", content: "Run inspection" },
      ],
      tools: [
        {
          name: "execute_command",
          description: "execute shell command",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    };

    const result = await withSessionAffinity("session-codex-affinity-99", () =>
      codexProvider.complete(request, { apiKey: codexKey("eu") }),
    );

    expect(result.text).toBe("Codex responses success");
    expect(result.usage?.cachedPromptTokens).toBe(40);
  });

  it("filters out disabled or non-picker models in Copilot catalog", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        return copilotTokenExchangeResponse();
      }
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o", name: "GPT-4o", model_picker_enabled: true },
              { id: "claude-sonnet-4.5", name: "Claude Sonnet", model_picker_enabled: true },
              { id: "hidden-embed", name: "Hidden Embeddings", model_picker_enabled: false },
              { id: "disabled-model", name: "Disabled Model", policy: { state: "disabled" } },
              { id: "no-tools", name: "No Tools Model", capabilities: { supports: { tool_calls: false } } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await copilotProvider.listModels!({
      apiKey: COPILOT_GITHUB_TOKEN,
    });

    expect(models).toEqual(["claude-sonnet-4.5", "gpt-4o"]);
    expect(models).not.toContain("hidden-embed");
    expect(models).not.toContain("disabled-model");
    expect(models).not.toContain("no-tools");
  });

  it("streams Claude models on Copilot via Anthropic messages SSE format", async () => {
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","content":[],"usage":{"input_tokens":30,"cache_read_input_tokens":15}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streaming from Claude"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        return copilotTokenExchangeResponse();
      }
      if (url.endsWith("/v1/messages")) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const request: CompletionRequest = {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "Stream me" }],
    };

    const result = await copilotProvider.stream!(
      request,
      { apiKey: COPILOT_GITHUB_TOKEN },
      (token) => tokens.push(token),
    );

    expect(tokens.join("")).toBe("Streaming from Claude");
    expect(result.text).toBe("Streaming from Claude");
    expect(result.usage?.cachedPromptTokens).toBe(15);
  });

  it("extracts system prompt to top-level instructions and omits system role from input for gpt-5.6-luna", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "resp_luna",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "gpt-5.6-luna responded successfully" }],
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 30,
              input_tokens_details: { cached_tokens: 60 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request: CompletionRequest = {
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: "Luna system instructions" },
        { role: "user", content: "Tell me something interesting" },
      ],
    };

    const result = await codexProvider.complete(request, { apiKey: codexKey() });

    expect(result.text).toBe("gpt-5.6-luna responded successfully");
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.model).toBe("gpt-5.6-luna");
    expect(capturedBody!.instructions).toBe("Luna system instructions");

    const inputItems = capturedBody!.input as Array<Record<string, unknown>>;
    expect(inputItems.some((item) => item.role === "system")).toBe(false);
    expect(inputItems).toHaveLength(1);
    expect(inputItems[0]!.role).toBe("user");
  });

  it("dynamically resolves to available model when requested model is unsupported on Copilot", async () => {
    let calledModel: string | undefined;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/copilot_internal/v2/token")) {
        return copilotTokenExchangeResponse();
      }
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-4o-mini", name: "GPT-4o Mini", model_picker_enabled: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calledModel = String(body.model);
        return new Response(
          JSON.stringify({
            id: "chatcmpl_mini",
            object: "chat.completion",
            choices: [
              {
                message: { role: "assistant", content: "Response from gpt-4o-mini" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 25,
              completion_tokens: 8,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const request: CompletionRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = await copilotProvider.complete(request, {
      apiKey: COPILOT_GITHUB_TOKEN,
    });

    expect(calledModel).toBe("gpt-4o-mini");
    expect(result.text).toBe("Response from gpt-4o-mini");
  });

  it("streams reasoning summary deltas to the UI sink for Codex models", async () => {
    const sseChunks = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_think"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"Thinking about "}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"the answer"}\n\n',
      'event: response.reasoning_summary_part.done\ndata: {"type":"response.reasoning_summary_part.done","item_id":"rs_1","summary_index":0,"part":{"type":"summary_text","text":"Thinking about the answer"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"Thinking about the answer"}]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Visible answer"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_think","status":"completed","usage":{"input_tokens":50,"output_tokens":20,"input_tokens_details":{"cached_tokens":30}}}}\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => {
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reasoningDeltas: string[] = [];
    const request: CompletionRequest = {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "Think hard" }],
      onStreamEvent: (event) => {
        if (event.type === "reasoning_delta") reasoningDeltas.push(event.text);
      },
    };

    const result = await codexProvider.stream!(
      request,
      { apiKey: codexKey() },
      () => {},
    );

    expect(result.text).toBe("Visible answer");
    expect(reasoningDeltas.join("")).toContain("Thinking about the answer");
    expect(result.reasoningBlock?.text).toContain("Thinking about the answer");
  });

  it("registers live reasoning levels from the ChatGPT models catalog", async () => {
    let modelsUrl = "";
    const fetchMock = vi.fn(async (input: unknown) => {
      modelsUrl = String(input);
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-luna",
              display_name: "GPT-5.6 Luna",
              visibility: "list",
              priority: 1,
              default_reasoning_level: "medium",
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "medium" },
                { effort: "high" },
                { effort: "xhigh" },
                { effort: "max" },
              ],
            },
            {
              slug: "hidden-model",
              display_name: "Hidden",
              visibility: "hide",
              priority: 9,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await codexProvider.listModels!({ apiKey: codexKey() });

    expect(modelsUrl).toContain("client_version=0.0.0");
    expect(models).toContain("gpt-5.6-luna");

    const { modelReasoningEfforts } = await import(
      "../src/llm/capabilities.js"
    );
    const efforts = modelReasoningEfforts("codex", "gpt-5.6-luna");
    expect(efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
