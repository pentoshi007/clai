import { describe, expect, it, vi } from "vitest";
import { resolveResponsesUrl } from "../../src/llm/responses-config.js";
import { normalizeEndpointUrl } from "../../src/llm/provider.js";
import { postResponses } from "../../src/llm/responses-http.js";
import { responsesStream } from "../../src/llm/responses-stream.js";
import { openAiCompatibleComplete, openAiCompatibleStream } from "../../src/llm/http.js";
import type { ResponsesDialectConfig } from "../../src/llm/responses-config.js";

describe("Responses API Endpoint Enforcement", () => {
  describe("resolveResponsesUrl", () => {
    it("appends /responses to root base URLs", () => {
      expect(resolveResponsesUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/responses");
      expect(resolveResponsesUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com/responses");
    });

    it("appends /responses to /v1 base URLs", () => {
      expect(resolveResponsesUrl("https://api.moonshot.ai/v1")).toBe("https://api.moonshot.ai/v1/responses");
      expect(resolveResponsesUrl("https://api.moonshot.ai/v1/")).toBe("https://api.moonshot.ai/v1/responses");
      expect(resolveResponsesUrl("https://ai-gateway.vercel.sh/v1")).toBe("https://ai-gateway.vercel.sh/v1/responses");
    });

    it("does not duplicate /responses if already present", () => {
      expect(resolveResponsesUrl("https://api.deepseek.com/responses")).toBe("https://api.deepseek.com/responses");
      expect(resolveResponsesUrl("https://api.moonshot.ai/v1/responses/")).toBe("https://api.moonshot.ai/v1/responses");
    });
  });

  describe("normalizeEndpointUrl", () => {
    it("strips /responses alongside /chat/completions and /models", () => {
      expect(normalizeEndpointUrl("https://api.moonshot.ai/v1/responses")).toBe("https://api.moonshot.ai/v1");
      expect(normalizeEndpointUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
      expect(normalizeEndpointUrl("https://api.openai.com/v1/models")).toBe("https://api.openai.com/v1");
    });

    it("does not force /v1 on api.deepseek.com", () => {
      expect(normalizeEndpointUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com");
      expect(normalizeEndpointUrl("https://api.deepseek.com/responses")).toBe("https://api.deepseek.com");
    });
  });

  describe("postResponses & responsesStream target /responses", () => {
    const dummyConfig: ResponsesDialectConfig = {
      baseUrl: "https://api.deepseek.com",
      providerId: "deepseek",
      displayName: "DeepSeek",
      artifactDialect: "openai-compatible",
      terminalPolicy: { proofs: ["response-completed"], naturalEofAccepted: false },
      buildHeaders: () => ({ "content-type": "application/json" }),
      reasoningPayload: () => undefined,
      bodyExtras: () => ({}),
    };

    it("postResponses fetches strictly from /responses", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "completed", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await postResponses(dummyConfig, { apiKey: "key" }, "{}", null, "application/json");

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/responses",
        expect.anything(),
      );
    });

    it("responsesStream connects strictly to /responses", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
                'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
            ),
          );
          controller.close();
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await responsesStream(
        dummyConfig,
        {
          provider: "deepseek",
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKey: "key" },
        () => {},
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/responses",
        expect.anything(),
      );
    });
  });

  describe("strict wireApi: responses does not fall back to chat", () => {
    it("openAiCompatibleComplete throws on /responses failure without falling back to /chat/completions", async () => {
      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/responses")) {
          return new Response(JSON.stringify({ error: { message: "Responses endpoint error" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "chat fallback" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        openAiCompatibleComplete({
          provider: "DeepSeek",
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          wireApi: "responses",
        }),
      ).rejects.toThrow();

      const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calledUrls.some((url) => url.includes("/chat/completions"))).toBe(false);
    });

    it("openAiCompatibleStream throws on /responses failure without falling back to /chat/completions", async () => {
      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/responses")) {
          return new Response(JSON.stringify({ error: { message: "Responses stream error" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("chat fallback", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        openAiCompatibleStream({
          provider: "DeepSeek",
          providerId: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          wireApi: "responses",
          onToken: () => {},
        }),
      ).rejects.toThrow();

      const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calledUrls.some((url) => url.includes("/chat/completions"))).toBe(false);
    });
  });
});
