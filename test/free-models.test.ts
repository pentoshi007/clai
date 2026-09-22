import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freeProvider,
  isKeylessModel,
  resolveFreeSource,
} from "../src/llm/free.js";
import { ProviderError } from "../src/llm/http.js";
import { resetResponsesWireStatesForTesting } from "../src/llm/wire/responses-first.js";

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

function catalogFetchMock(
  zenIds: string[],
  kiloEntries: Array<{ id: string; isFree?: boolean }>,
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("kilo.ai")) {
      return new Response(JSON.stringify({ data: kiloEntries }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ data: zenIds.map((id) => ({ id })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

describe("free provider (zen + kilo)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  describe("isKeylessModel", () => {
    it("treats any -free suffixed id as keyless", () => {
      expect(isKeylessModel("deepseek-v4-flash-free")).toBe(true);
      expect(isKeylessModel("mimo-v2.5-free")).toBe(true);
      expect(isKeylessModel("Some-New-Model-FREE")).toBe(true);
    });

    it("treats the MiMo 2.6 Flash free id as keyless", () => {
      expect(isKeylessModel("free-1/mimo-v2.6-flash-free")).toBe(true);
    });

    it("treats curated ids without the suffix as keyless", () => {
      expect(isKeylessModel("big-pickle")).toBe(true);
    });

    it("treats other ids as premium", () => {
      expect(isKeylessModel("gpt-5")).toBe(false);
      expect(isKeylessModel("claude-opus-4-6")).toBe(false);
      expect(isKeylessModel("deepseek-v4-pro")).toBe(false);
    });

    it("applies the zen rules to free-1/ prefixed ids", () => {
      expect(isKeylessModel("free-1/deepseek-v4-flash-free")).toBe(true);
      expect(isKeylessModel("free-1/big-pickle")).toBe(true);
      expect(isKeylessModel("free-1/gpt-5")).toBe(false);
    });

    it("applies the kilo rules to free-2/ prefixed ids", () => {
      expect(
        isKeylessModel("free-2/nvidia/nemotron-3-ultra-550b-a55b:free"),
      ).toBe(true);
      expect(isKeylessModel("free-2/kilo-auto/free")).toBe(true);
      expect(isKeylessModel("free-2/openrouter/free")).toBe(true);
      expect(isKeylessModel("free-2/anthropic/claude-sonnet-4.6")).toBe(false);
    });
  });

  describe("resolveFreeSource", () => {
    it("maps prefixes to their gateway and strips them", () => {
      const zen = resolveFreeSource("free-1/hy3-free");
      expect(zen.source.id).toBe("free-1");
      expect(zen.model).toBe("hy3-free");

      const kilo = resolveFreeSource("free-2/tencent/hy3:free");
      expect(kilo.source.id).toBe("free-2");
      expect(kilo.model).toBe("tencent/hy3:free");

      const bare = resolveFreeSource("hy3-free");
      expect(bare.source.id).toBe("free-1");
      expect(bare.model).toBe("hy3-free");
    });
  });

  describe("listModels", () => {
    it("fetches both catalogs without an Authorization header when keyless", async () => {
      const fetchMock = catalogFetchMock(
        ["hy3-free", "deepseek-v4-flash-free"],
        [
          { id: "kilo-auto/free", isFree: true },
          { id: "x/premium-model", isFree: false },
        ],
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(baseTime);

      const result = await freeProvider.listModels!({});
      expect(result).toEqual([
        "free-1/deepseek-v4-flash-free",
        "free-1/hy3-free",
        "free-2/kilo-auto/free",
      ]);

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain(ZEN_MODELS_URL);
      expect(urls).toContain(KILO_MODELS_URL);
      for (const call of fetchMock.mock.calls) {
        const options = call[1] as RequestInit;
        expect(options.headers).not.toHaveProperty("authorization");
      }
    });

    it("shows only free models from each source", async () => {
      const fetchMock = catalogFetchMock(
        ["claude-opus-4-8", "deepseek-v4-flash-free", "gpt-5", "mimo-v2.5-free"],
        [
          { id: "stepfun/step-3.7-flash:free" },
          { id: "anthropic/claude-opus-4.8", isFree: false },
          { id: "openrouter/free", isFree: true },
        ],
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(baseTime + 3 * 60 * 60 * 1000);

      const result = await freeProvider.listModels!({});
      expect(result).toEqual([
        "free-1/deepseek-v4-flash-free",
        "free-1/mimo-v2.5-free",
        "free-2/openrouter/free",
        "free-2/stepfun/step-3.7-flash:free",
      ]);
    });

    it("sends the Authorization header when a key is configured", async () => {
      const fetchMock = catalogFetchMock(
        ["hy3-free"],
        [{ id: "kilo-auto/free", isFree: true }],
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

      await freeProvider.listModels!({ apiKey: "zen-key-123" });
      for (const call of fetchMock.mock.calls) {
        const options = call[1] as RequestInit;
        expect(options.headers).toMatchObject({
          authorization: "Bearer zen-key-123",
        });
      }
    });

    it("caches the catalogs within the TTL", async () => {
      const fetchMock = catalogFetchMock(
        ["hy3-free"],
        [{ id: "kilo-auto/free", isFree: true }],
      );
      vi.stubGlobal("fetch", fetchMock);

      const time = baseTime + 5 * 60 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValue(time);
      await freeProvider.listModels!({});
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
      const result = await freeProvider.listModels!({});
      expect(result).toEqual(["free-1/hy3-free", "free-2/kilo-auto/free"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("refetches once the catalog cache passes 30 minutes", async () => {
      const fetchMock = catalogFetchMock(
        ["mimo-v2.5-free"],
        [{ id: "kilo-auto/free", isFree: true }],
      );
      vi.stubGlobal("fetch", fetchMock);

      const time = baseTime + 6 * 60 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValue(time);
      await freeProvider.listModels!({});
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.spyOn(Date, "now").mockReturnValue(time + 29 * 60 * 1000);
      await freeProvider.listModels!({});
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.spyOn(Date, "now").mockReturnValue(time + 31 * 60 * 1000);
      await freeProvider.listModels!({});
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("falls back to the curated lists when the catalog fetches fail", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("network down");
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(baseTime + 9 * 60 * 60 * 1000);

      const result = await freeProvider.listModels!({});
      expect(result).toContain("free-1/deepseek-v4-flash-free");
      expect(result).toContain("free-1/mimo-v2.6-flash-free");
      expect(result).toContain("free-2/kilo-auto/free");
      expect(result).toContain(
        "free-2/nvidia/nemotron-3-ultra-550b-a55b:free",
      );
      expect(result.every((id) => /free/i.test(id))).toBe(true);
    });
  });

  describe("complete", () => {
    beforeEach(() => {
      resetResponsesWireStatesForTesting();
    });

    function jsonCompletionMock() {
      return vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/responses")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      });
    }

    function sseCompletionMock() {
      return vi.fn(async (url: string | URL) => {
        if (String(url).endsWith("/responses")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
    }

    it("sends no Authorization header for a keyless free model", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "deepseek-v4-flash-free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        "https://opencode.ai/zen/v1/chat/completions",
      );
      expect(request.headers).toMatchObject({
        authorization: "Bearer public",
      });
    });

    it("routes free-1/ models to the zen gateway with the prefix stripped", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-1/deepseek-v4-flash-free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        "https://opencode.ai/zen/v1/chat/completions",
      );
      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as { model?: string };
      expect(body.model).toBe("deepseek-v4-flash-free");
      expect(request.headers).toMatchObject({
        authorization: "Bearer public",
      });
    });

    it("routes MiMo 2.6 Flash through free-1 with its upstream free id", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-1/mimo-v2.6-flash-free",
          messages: [{ role: "user", content: "think" }],
          thinking: { enabled: true, effort: "high" },
        },
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        "https://opencode.ai/zen/v1/chat/completions",
      );
      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        model?: string;
        reasoning_effort?: string;
      };
      expect(body.model).toBe("mimo-v2.6-flash-free");
      expect(body.reasoning_effort).toBeUndefined();
    });

    it.each(["xhigh", "max"] as const)(
      "omits MiMo 2.6 Flash effort %s for the zen gateway",
      async (effort) => {
        const fetchMock = sseCompletionMock();
        vi.stubGlobal("fetch", fetchMock);

        await freeProvider.complete(
          {
            model: "free-1/mimo-v2.6-flash-free",
            messages: [{ role: "user", content: "think" }],
            thinking: { enabled: true, effort },
          },
          {},
        );

        const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
        const body = JSON.parse(String(request.body)) as {
          model?: string;
          reasoning_effort?: string;
        };
        expect(body.model).toBe("mimo-v2.6-flash-free");
        expect(body.reasoning_effort).toBeUndefined();
      },
    );

    it("still clamps xhigh to high for other zen models", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-1/hy3-free",
          messages: [{ role: "user", content: "think" }],
          thinking: { enabled: true, effort: "xhigh" },
        },
        {},
      );

      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        reasoning_effort?: string;
      };
      expect(body.reasoning_effort).toBe("high");
    });

    it("streams Free1 completions directly without a non-streaming attempt", async () => {
      const requests: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await freeProvider.complete(
        {
          model: "free-1/future-model-free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      expect(result.text).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.stream).toBe(true);
      expect(requests[0]?.model).toBe("future-model-free");
    });

    it("routes free-2/ models to the kilo gateway with the prefix stripped", async () => {
      const fetchMock = jsonCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-2/nvidia/nemotron-3-ultra-550b-a55b:free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        "https://api.kilo.ai/api/gateway/chat/completions",
      );
      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as { model?: string };
      expect(body.model).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
      expect(request.headers).not.toHaveProperty("authorization");
    });

    it("rejects a premium model without a key with a 402-style error", async () => {
      const fetchMock = jsonCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      const error = await freeProvider
        .complete(
          {
            model: "gpt-5",
            messages: [{ role: "user", content: "hi" }],
          },
          {},
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(402);
      expect((error as ProviderError).message).toMatch(/requires an API key/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a premium kilo model without a key with a 402-style error", async () => {
      const fetchMock = jsonCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      const error = await freeProvider
        .complete(
          {
            model: "free-2/anthropic/claude-sonnet-4.6",
            messages: [{ role: "user", content: "hi" }],
          },
          {},
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).status).toBe(402);
      expect((error as ProviderError).message).toMatch(/requires an API key/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows a premium model and sends the key when one is configured", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKey: "zen-key-123" },
      );

      const request = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(request.headers).toMatchObject({
        authorization: "Bearer zen-key-123",
      });
    });

    it("maps thinking onto an OpenAI-style reasoning_effort for deepseek", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "deepseek-v4-flash-free",
          messages: [{ role: "user", content: "think" }],
          thinking: { enabled: true, effort: "high" },
        },
        {},
      );

      const request = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        reasoning_effort?: string;
      };
      expect(body.reasoning_effort).toBe("high");
    });

    it("presents zen requests as the opencode client with fresh request ids", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      const requestInput = {
        model: "free-1/mimo-v2.5-free",
        messages: [{ role: "user" as const, content: "hi" }],
      };
      await freeProvider.complete(requestInput, {});
      await freeProvider.complete(requestInput, {});

      const first = fetchMock.mock.calls[0]![1] as Record<string, unknown>;
      const second = fetchMock.mock.calls[1]![1] as Record<string, unknown>;
      expect(first.headers).toMatchObject({
        "user-agent": "opencode/2.0.8",
        "x-opencode-client": "cli",
        authorization: "Bearer public",
      });
      const firstHeaders = first.headers as Record<string, string>;
      const secondHeaders = second.headers as Record<string, string>;
      expect(firstHeaders["x-opencode-session"]).toMatch(/^ses_[0-9a-fA-Za-z]+$/);
      expect(firstHeaders["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{32}$/);
      expect(firstHeaders).not.toHaveProperty("x-opencode-project");
      expect(firstHeaders).not.toHaveProperty("x-session-affinity");
      expect(firstHeaders).not.toHaveProperty("x-session-id");
      expect(secondHeaders["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{32}$/);
      expect(secondHeaders["x-opencode-request"]).not.toBe(
        firstHeaders["x-opencode-request"],
      );
    });

    it("presents kilo requests as the kilocode client", async () => {
      const fetchMock = jsonCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-2/kilo-auto/free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      const request = fetchMock.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(request.headers).toMatchObject({
        "user-agent": "opencode-kilo-provider",
        "x-kilocode-editorname": "Kilo CLI",
      });
      expect(request.headers).not.toHaveProperty("authorization");
    });

    it("injects read and shell tools into free-1 chat requests when none are provided", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-1/mimo-v2.5-free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
      };
      const names = (body.tools ?? []).map((t) => t.function?.name);
      expect(names).toContain("read");
      expect(names).toContain("shell");
    });

    it("keeps existing tools and appends read and shell for free-1 chat requests", async () => {
      const fetchMock = sseCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "mimo-v2.5-free",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              name: "fs_read",
              wireName: "fs_read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
          toolChoice: "auto",
        },
        {},
      );

      const request = fetchMock.mock.calls.at(-1)![1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
        tool_choice?: unknown;
      };
      const names = (body.tools ?? []).map((t) => t.function?.name);
      expect(names).toEqual(expect.arrayContaining(["fs_read", "read", "shell"]));
      expect(body.tool_choice).toBe("auto");
    });

    it("does not inject read and shell tools into free-2 chat requests", async () => {
      const fetchMock = jsonCompletionMock();
      vi.stubGlobal("fetch", fetchMock);

      await freeProvider.complete(
        {
          model: "free-2/nvidia/nemotron-3-ultra-550b-a55b:free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      const chatCall = fetchMock.mock.calls.find((call) =>
        String(call[0]).endsWith("/chat/completions"),
      );
      const body = JSON.parse(String(chatCall![1]?.body)) as {
        tools?: unknown[];
      };
      expect(body.tools ?? []).toHaveLength(0);
    });

    it("does not probe /responses for zen free models", async () => {
      const fetchMock = vi.fn(async (input: unknown) => {
        if (String(input).endsWith("/responses")) {
          return new Response(
            JSON.stringify({ error: { message: "Internal server error" } }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await freeProvider.complete(
        {
          model: "free-1/mimo-v2.5-free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      expect(result.text).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        "https://opencode.ai/zen/v1/chat/completions",
      );
    });

    it("probes /responses first for kilo free models", async () => {
      const bodies: Record<string, unknown>[] = [];
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (String(input).endsWith("/responses")) {
          return new Response(
            JSON.stringify({
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "responses-ok" }],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "chat-ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await freeProvider.complete(
        {
          model: "free-2/kilo-auto/free",
          messages: [{ role: "user", content: "hi" }],
        },
        {},
      );

      expect(result.text).toBe("responses-ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        "https://api.kilo.ai/api/gateway/responses",
      );
      expect(bodies[0]?.max_output_tokens).toBe(128);
      expect(JSON.stringify(bodies[0]?.input)).toContain("21 multiplied by 4");
      expect(JSON.stringify(bodies[1]?.input)).toContain("hi");
    });
  });
});
