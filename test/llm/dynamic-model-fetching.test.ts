import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../../src/llm/anthropic.js";
import { ollamaProvider } from "../../src/llm/ollama.js";
import { deepseekProvider } from "../../src/llm/deepseek.js";
import { kimiProvider } from "../../src/llm/kimi.js";
import { glmProvider } from "../../src/llm/glm.js";
import { minimaxProvider } from "../../src/llm/minimax.js";
import { providers } from "../../src/llm/routing/provider-selection.js";
import { resolveModelsForProvider } from "../../src/ui-core/commands/picker-commands.js";
import { knownModels } from "../../src/app/commands/catalog.js";

describe("Dynamic Model Fetching Across All Providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("all registered providers implement listModels", () => {
    it("every provider in the active providers registry has listModels defined", () => {
      const entries = Object.entries(providers);
      expect(entries.length).toBeGreaterThanOrEqual(25);
      for (const [id, provider] of entries) {
        expect(
          typeof provider.listModels,
          `Provider ${id} must implement listModels dynamically`,
        ).toBe("function");
      }
    });
  });

  describe("Anthropic dynamic model listing", () => {
    it("requires API key", async () => {
      await expect(anthropicProvider.listModels!({})).rejects.toThrow(
        "Anthropic API key is required",
      );
    });

    it("fetches dynamically from /v1/models and parses model ids", async () => {
      const mockResponse = {
        data: [
          { id: "claude-3-7-sonnet-20250219", type: "model" },
          { id: "claude-3-5-haiku-20241022", type: "model" },
          { id: "claude-3-5-sonnet-20241022", type: "model" },
        ],
      };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await anthropicProvider.listModels!({
        apiKey: "sk-ant-testkey12345678",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-api-key": "sk-ant-testkey12345678",
            "anthropic-version": "2023-06-01",
          }),
        }),
      );
      expect(models).toEqual([
        "claude-3-5-haiku-20241022",
        "claude-3-5-sonnet-20241022",
        "claude-3-7-sonnet-20250219",
      ]);
    });
  });

  describe("Ollama dynamic model listing", () => {
    it("fetches dynamically from /api/tags and parses model names", async () => {
      const mockResponse = {
        models: [
          { name: "llama3.2:latest", model: "llama3.2:latest" },
          { name: "deepseek-r1:14b", model: "deepseek-r1:14b" },
          { name: "qwen2.5-coder:32b", model: "qwen2.5-coder:32b" },
        ],
      };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await ollamaProvider.listModels!({
        apiKey: "http://localhost:11434",
      });

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/api/tags");
      expect(models).toEqual([
        "deepseek-r1:14b",
        "llama3.2:latest",
        "qwen2.5-coder:32b",
      ]);
    });
  });

  describe("Chinese providers dynamic model listing & catalog cleanup", () => {
    it("Chinese providers are not in hardcoded knownModels", () => {
      expect(knownModels["deepseek"]).toBeUndefined();
      expect(knownModels["kimi"]).toBeUndefined();
      expect(knownModels["glm"]).toBeUndefined();
      expect(knownModels["minimax"]).toBeUndefined();
    });

    it("deepseekProvider.listModels fetches dynamically from api.deepseek.com", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await deepseekProvider.listModels!({
        apiKey: "sk-test123456789012",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/models",
        expect.anything(),
      );
      expect(models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    });

    it("kimiProvider.listModels fetches dynamically from api.moonshot.ai", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "kimi-k3" }, { id: "kimi-k2.6" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await kimiProvider.listModels!({
        apiKey: "sk-test123456789012",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.moonshot.ai/v1/models",
        expect.anything(),
      );
      expect(models).toEqual(["kimi-k2.6", "kimi-k3"]);
    });

    it("glmProvider.listModels fetches dynamically from api.z.ai", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "glm-4-plus" }, { id: "glm-4-flash" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await glmProvider.listModels!({
        apiKey: "testkey123456789012",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.z.ai/api/paas/v4/models",
        expect.anything(),
      );
      expect(models).toEqual(["glm-4-flash", "glm-4-plus"]);
    });

    it("minimaxProvider.listModels fetches dynamically from api.minimaxi.chat", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [{ id: "MiniMax-Text-01" }, { id: "MiniMax-M3" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await minimaxProvider.listModels!({
        apiKey: "testkey123456789012",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.minimaxi.chat/v1/models",
        expect.anything(),
      );
      expect(models).toEqual(["MiniMax-M3", "MiniMax-Text-01"]);
    });
  });

  describe("resolveModelsForProvider strictly uses dynamic models without hardcoded fallback", () => {
    it("returns empty array and error when provider listModels fails", async () => {
      const provider = providers["deepseek"];
      vi.spyOn(provider, "listModels" as "listModels").mockRejectedValue(
        new Error("Network connection refused"),
      );

      const result = await resolveModelsForProvider("deepseek");
      expect(result.models).toEqual([]);
      expect(result.source).toBe("known");
      expect(result.error).toContain("Network connection refused");
    });

    it("returns dynamic live models when listModels succeeds", async () => {
      const provider = providers["deepseek"];
      vi.spyOn(provider, "listModels" as "listModels").mockResolvedValue([
        "deepseek-chat-live",
        "deepseek-reasoner-live",
      ]);

      const result = await resolveModelsForProvider("deepseek");
      expect(result.models).toEqual([
        "deepseek-chat-live",
        "deepseek-reasoner-live",
      ]);
      expect(result.source).toBe("live");
      expect(result.error).toBeUndefined();
    });
  });
});
