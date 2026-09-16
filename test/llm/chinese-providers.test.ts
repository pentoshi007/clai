import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deepseekProvider } from "../../src/llm/deepseek.js";
import { kimiProvider } from "../../src/llm/kimi.js";
import { glmProvider } from "../../src/llm/glm.js";
import { minimaxProvider } from "../../src/llm/minimax.js";
import { envValue } from "../../src/store/keys.js";
import { modelContextWindow } from "../../src/llm/context-windows.js";
import { providers } from "../../src/llm/routing/provider-selection.js";

describe("Chinese LLM Providers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("registration & provider identity", () => {
    it("registers deepseek, kimi, glm, and minimax in providers map", () => {
      expect(providers.deepseek).toBe(deepseekProvider);
      expect(providers.kimi).toBe(kimiProvider);
      expect(providers.glm).toBe(glmProvider);
      expect(providers.minimax).toBe(minimaxProvider);
    });

    it("validates keys correctly per provider format", () => {
      expect(deepseekProvider.validateKey("sk-1234567890123456")).toBe(true);
      expect(deepseekProvider.validateKey("sk-short")).toBe(false);
      expect(deepseekProvider.validateKey("invalid-prefix-123456")).toBe(false);

      expect(kimiProvider.validateKey("sk-1234567890123456")).toBe(true);
      expect(kimiProvider.validateKey("sk-short")).toBe(false);

      expect(glmProvider.validateKey("1234567890123456.abcdef")).toBe(true);
      expect(glmProvider.validateKey("short")).toBe(false);

      expect(minimaxProvider.validateKey("1234567890123456abcdef")).toBe(true);
      expect(minimaxProvider.validateKey("short")).toBe(false);
    });

    it("resolves fallback environment variables for kimi and glm", () => {
      delete process.env.KIMI_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      expect(envValue("kimi")).toBeUndefined();
      process.env.MOONSHOT_API_KEY = "sk-moonshot-env-key-123";
      expect(envValue("kimi")).toBe("sk-moonshot-env-key-123");
      process.env.KIMI_API_KEY = "sk-kimi-env-key-456";
      expect(envValue("kimi")).toBe("sk-kimi-env-key-456");

      delete process.env.GLM_API_KEY;
      delete process.env.ZHIPU_API_KEY;
      delete process.env.ZAI_API_KEY;
      expect(envValue("glm")).toBeUndefined();
      process.env.ZAI_API_KEY = "zai-key-123456789";
      expect(envValue("glm")).toBe("zai-key-123456789");
      process.env.ZHIPU_API_KEY = "zhipu-key-123456789";
      expect(envValue("glm")).toBe("zhipu-key-123456789");
      process.env.GLM_API_KEY = "glm-key-123456789";
      expect(envValue("glm")).toBe("glm-key-123456789");
    });

    it("verifies MiniMax-Text-01 4M context window", () => {
      expect(modelContextWindow("MiniMax-Text-01", "minimax")).toBe(4_000_000);
      expect(modelContextWindow("minimax-m3", "minimax")).toBe(1_000_000);
    });
  });

  describe("DeepSeek provider API calls", () => {
    it("listModels fetches from DeepSeek models endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "deepseek-chat" },
              { id: "deepseek-reasoner" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await deepseekProvider.listModels!({ apiKey: "sk-test-deepseek-key-1" });
      expect(models).toContain("deepseek-chat");
      expect(models).toContain("deepseek-reasoner");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/models",
        expect.objectContaining({
          headers: { authorization: "Bearer sk-test-deepseek-key-1" },
        }),
      );
    });

    it("complete handles reasoning_content and cache hit tokens", async () => {
      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/responses")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Final answer",
                  reasoning_content: "Step by step reasoning",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              prompt_cache_hit_tokens: 80,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await deepseekProvider.complete(
        {
          provider: "deepseek",
          model: "deepseek-reasoner",
          messages: [{ role: "user", content: "Solve this problem" }],
          thinking: { enabled: true, effort: "high" },
        },
        { apiKey: "sk-test-deepseek-key-1" },
      );

      expect(result.text).toBe("Final answer");
      expect(result.reasoningBlock?.text).toBe("Step by step reasoning");
      expect(result.usage?.cachedPromptTokens).toBe(80);
    });
  });

  describe("Kimi provider API calls", () => {
    it("listModels fetches from Moonshot models endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "kimi-k3" },
              { id: "moonshot-v1-8k" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await kimiProvider.listModels!({ apiKey: "sk-test-kimi-key-1" });
      expect(models).toContain("kimi-k3");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.moonshot.ai/v1/models",
        expect.objectContaining({
          headers: { authorization: "Bearer sk-test-kimi-key-1" },
        }),
      );
    });

    it("complete maps prompt_tokens_details.cached_tokens", async () => {
      const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/responses")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Kimi response",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 200,
              completion_tokens: 30,
              total_tokens: 230,
              prompt_tokens_details: {
                cached_tokens: 150,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await kimiProvider.complete(
        {
          provider: "kimi",
          model: "kimi-k3",
          messages: [{ role: "user", content: "Hello Kimi" }],
        },
        { apiKey: "sk-test-kimi-key-1" },
      );

      expect(result.text).toBe("Kimi response");
      expect(result.usage?.cachedPromptTokens).toBe(150);
    });
  });

  describe("GLM provider API calls", () => {
    it("listModels fetches from Z.AI models endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "glm-4-plus" },
              { id: "glm-4-flash" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await glmProvider.listModels!({ apiKey: "glm-test-key-12345" });
      expect(models).toContain("glm-4-plus");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.z.ai/api/paas/v4/models",
        expect.objectContaining({
          headers: { authorization: "Bearer glm-test-key-12345" },
        }),
      );
    });
  });

  describe("MiniMax provider API calls", () => {
    it("listModels fetches from MiniMax models endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "MiniMax-Text-01" },
              { id: "MiniMax-M3" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await minimaxProvider.listModels!({ apiKey: "minimax-test-key-12345" });
      expect(models).toContain("MiniMax-Text-01");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.minimaxi.chat/v1/models",
        expect.objectContaining({
          headers: { authorization: "Bearer minimax-test-key-12345" },
        }),
      );
    });
  });
});
