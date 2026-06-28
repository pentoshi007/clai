import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiProvider } from "../src/llm/gemini.js";

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

  it("throws when no API key is configured", async () => {
    await expect(geminiProvider.listModels!({})).rejects.toThrow(
      "Gemini API key is required"
    );
  });
});
