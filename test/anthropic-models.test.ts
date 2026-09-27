import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelContextWindow, modelMaxOutputTokens } from "../src/llm/context-windows.js";
import { resetReasoningKnowledge } from "../src/llm/capabilities.js";
import {
  anthropicProvider,
  resetAnthropicModelCatalogCache,
} from "../src/llm/anthropic.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Anthropic model catalog", () => {
  beforeEach(() => {
    resetAnthropicModelCatalogCache();
    resetReasoningKnowledge();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAnthropicModelCatalogCache();
    resetReasoningKnowledge();
  });

  it("ingests context limits across pages and isolates cache by endpoint and key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        data: [{ id: "anthropic-window-page-one", max_input_tokens: 128_000, max_tokens: 32_000 }],
        has_more: true,
        last_id: "anthropic-window-page-one",
      }))
      .mockResolvedValueOnce(json({
        data: [{ id: "anthropic-window-page-two", max_input_tokens: 512_000, max_tokens: 64_000 }],
        has_more: false,
        last_id: "anthropic-window-page-two",
      }))
      .mockImplementation(async () => json({ data: [], has_more: false }));
    vi.stubGlobal("fetch", fetchMock);

    const endpoint = "https://anthropic.example/v1";
    await anthropicProvider.listModels!({ apiKey: "anthropic-test-key-a", baseUrl: endpoint });

    expect(modelContextWindow("anthropic-window-page-two", "anthropic")).toBe(512_000);
    expect(modelMaxOutputTokens("anthropic", "anthropic-window-page-two")).toBe(64_000);
    const nextPageUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(nextPageUrl.searchParams.get("after_id")).toBe("anthropic-window-page-one");

    await anthropicProvider.listModels!({ apiKey: "anthropic-test-key-a", baseUrl: endpoint });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await anthropicProvider.listModels!({ apiKey: "anthropic-test-key-a", baseUrl: "https://other.example/v1" });
    await anthropicProvider.listModels!({ apiKey: "anthropic-test-key-b", baseUrl: endpoint });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
