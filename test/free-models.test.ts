import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freeProvider,
  isKeylessModel,
  resolveFreeSource,
} from "../src/llm/free.js";
import { ProviderError } from "../src/llm/http.js";

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

    it("falls back to the curated lists when the catalog fetches fail", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("network down");
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(Date, "now").mockReturnValue(baseTime + 9 * 60 * 60 * 1000);

      const result = await freeProvider.listModels!({});
      expect(result).toContain("free-1/deepseek-v4-flash-free");
      expect(result).toContain("free-2/kilo-auto/free");
      expect(result).toContain(
        "free-2/nvidia/nemotron-3-ultra-550b-a55b:free",
      );
      expect(result.every((id) => /free/i.test(id))).toBe(true);
    });
  });

  describe("complete", () => {
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

    it("sends no Authorization header for a keyless free model", async () => {
      const fetchMock = jsonCompletionMock();
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
      expect(request.headers).not.toHaveProperty("authorization");
    });

    it("routes free-1/ models to the zen gateway with the prefix stripped", async () => {
      const fetchMock = jsonCompletionMock();
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
      expect(request.headers).not.toHaveProperty("authorization");
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
      const fetchMock = jsonCompletionMock();
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
      const fetchMock = jsonCompletionMock();
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
  });
});
