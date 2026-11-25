import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenrouterProvider } from "../src/llm/tokenrouter.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import { resetResponsesWireStatesForTesting } from "../src/llm/wire/responses-first.js";
import type { CompletionRequest } from "../src/types.js";

describe("TokenRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "openai/gpt-5.4-nano" },
        { id: "qwen/qwen3.5-9b" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await tokenrouterProvider.listModels!({ apiKey: "tr-testkey12345678" });
    expect(result).toEqual([
      "openai/gpt-5.4-nano",
      "qwen/qwen3.5-9b",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer tr-testkey12345678",
    });
  });

  it("surfaces the fetch error instead of silently returning an empty list", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Invalid API key", type: "api_error" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass any cache from prior tests.
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    await expect(
      tokenrouterProvider.listModels!({ apiKey: "tr-badkey12345678" }),
    ).rejects.toThrow(/401/);
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "openai/gpt-5.4-nano" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await tokenrouterProvider.listModels!({ apiKey: "tr-cachekey12345678" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await tokenrouterProvider.listModels!({ apiKey: "tr-cachekey12345678" });
    expect(result).toEqual(["openai/gpt-5.4-nano"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("TokenRouter request routing", () => {
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }];
  const chat = () => Response.json({ choices: [{ message: { content: "Done" } }] });

  afterEach(() => {
    resetResponsesWireStatesForTesting();
    vi.unstubAllGlobals();
  });

  it.each([
    ["openai", "chat/completions"],
    ["openai-response", "responses"],
  ])("dispatches new catalog models via their advertised %s endpoint", async (endpoint, path) => {
    const model = `future-vendor/${endpoint}-model`;
    const auth = { apiKey: `fixture-key-${endpoint}` };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: model, supported_endpoint_types: [endpoint] }] });
      expect(url).toMatch(new RegExp(`/v1/${path}$`));
      return path === "responses" ? Response.json({ status: "completed", output }) : chat();
    });
    vi.stubGlobal("fetch", fetchMock);

    await tokenrouterProvider.listModels!(auth);
    const result = await tokenrouterProvider.complete({ model, messages: [{ role: "user", content: "Continue" }] }, auth);
    expect(result).toMatchObject({ model, text: "Done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays tool calls with stable Responses item IDs and cache affinity", async () => {
    const model = "future-vendor/dual-route-model";
    const auth = { apiKey: "fixture-tool-replay-key" };
    const request: CompletionRequest = {
      model,
      messages: [
        { role: "user", content: "Look up the count" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_count", name: "lookup_count", args: {} }] },
        { role: "tool", content: "23", name: "lookup_count", toolCallId: "call_count" },
      ],
    };
    const bodies: Array<{ input: Array<Record<string, unknown>>; prompt_cache_key: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return Response.json({ data: [{ id: model, supported_endpoint_types: ["openai", "openai-response"] }] });
      expect(url).toMatch(/\/v1\/responses$/);
      const body = JSON.parse(String(init?.body)) as typeof bodies[number];
      const call = body.input.find((item) => item.type === "function_call");
      if (call) {
        if (!call.id) return Response.json({ error: { code: "json_parse_error", message: "Bad request." } }, { status: 400 });
        bodies.push(body);
      }
      return Response.json({ status: "completed", output, usage: { input_tokens: 256, input_tokens_details: { cached_tokens: 128 } } });
    }));

    await tokenrouterProvider.listModels!(auth);
    await withSessionAffinity("tokenrouter-tool-replay-fixture", async () => {
      for (const messages of [request.messages, [...request.messages, { role: "user" as const, content: "Continue" }]]) {
        const result = await tokenrouterProvider.stream!({ ...request, messages }, auth, () => {});
        expect(result).toMatchObject({ text: "Done", api: "responses", usage: { cachedPromptTokens: 128 } });
      }
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", id: expect.stringMatching(/^fc_[a-f0-9]{32}$/), call_id: "call_count" }),
      { type: "function_call_output", call_id: "call_count", output: "23" },
    ]));
    expect(bodies[1]?.input.slice(0, -1)).toEqual(bodies[0]?.input);
    expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
  });

  it("falls back to Chat Completions if an undiscovered model rejects the Responses preflight schema", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      return path.endsWith("/responses")
        ? Response.json({ error: { code: "json_parse_error", message: "Bad request." } }, { status: 400 })
        : chat();
    }));
    const result = await tokenrouterProvider.complete({
      model: "unlisted/new-reasoning-model",
      messages: [{ role: "user", content: "Continue" }],
    }, { apiKey: "fixture-preflight-fallback-key" });
    expect(result).toMatchObject({ text: "Done", api: "chat-completions" });
    expect(paths).toEqual(["/v1/responses", "/v1/chat/completions"]);
  });
});
