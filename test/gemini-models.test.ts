import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiProvider } from "../src/llm/gemini.js";
import { modelCatalogFacts } from "../src/llm/capabilities.js";
import { modelContextWindow, modelMaxOutputTokens } from "../src/llm/context-windows.js";

describe("Gemini key validation", () => {
  it("accepts classic AIza and newer AQ. API keys", () => {
    // Synthetic fixtures only — must match validateKey shape, not real secrets.
    expect(
      geminiProvider.validateKey("AIzaSyTEST_fixture_key_not_real_0001"),
    ).toBe(true);
    expect(
      geminiProvider.validateKey("AQ.test_fixture_key_not_a_real_secret"),
    ).toBe(true);
    expect(geminiProvider.validateKey("sk-not-gemini")).toBe(false);
    expect(geminiProvider.validateKey("AQ.short")).toBe(false);
  });
});

describe("Gemini model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls fetch on Gemini models API and returns filtered results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        {
          name: "models/gemini-3.5-flash",
          supportedGenerationMethods: ["generateContent"]
        },
        {
          name: "models/gemini-2.5-flash",
          supportedGenerationMethods: ["generateContent"]
        },
        {
          name: "models/gemini-some-other",
          supportedGenerationMethods: ["embedContent"]
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geminiProvider.listModels!({ apiKey: "AIzaTestKey" });
    expect(result).toEqual([
      "gemini-2.5-flash",
      "gemini-3.5-flash"
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("https://generativelanguage.googleapis.com/v1beta/models");
    expect(String(fetchCallArgs[0])).toContain("key=AIzaTestKey");
  });

  it("registers each model's official input and output token limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [
        {
          name: "models/gemini-9-pro",
          supportedGenerationMethods: ["generateContent"],
          inputTokenLimit: 2_097_152,
          outputTokenLimit: 65_536,
          temperature: 1,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await geminiProvider.listModels!({ apiKey: "AIzaTestKey" });

    expect(modelContextWindow("gemini-9-pro", "gemini")).toBe(2_097_152);
    expect(modelMaxOutputTokens("gemini", "gemini-9-pro")).toBe(65_536);
    expect(modelCatalogFacts("gemini", "gemini-9-pro")?.defaultSampling).toBeUndefined();
  });

  it("throws when no API key is configured", async () => {
    await expect(geminiProvider.listModels!({})).rejects.toThrow(
      "Gemini API key is required"
    );
  });
});
