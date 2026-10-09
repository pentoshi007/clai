import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clineProvider, resetClineModelCache } from "../src/llm/cline.js";
import { resetClineModelMetadataCache } from "../src/llm/cline-model-catalog.js";
import { clearModelCatalogFacts, modelCatalogFacts, resetReasoningKnowledge } from "../src/llm/capabilities.js";

const catalog = {
  recommended: [
    { id: "openai/gpt-6-astra", name: "gpt-6-astra" },
    { id: "anthropic/claude-opus-5", name: "claude-opus-5" },
  ],
  free: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4" },
  ],
  clinePass: [{ id: "cline-pass/glm-5.3", name: "glm-5.3" }],
};

function catalogResponse(value: unknown = catalog) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Cline provider", () => {
  beforeEach(() => {
    resetClineModelCache();
    resetClineModelMetadataCache();
    resetReasoningKnowledge();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("lists the flattened catalog and sends desktop client headers", async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) =>
      url.includes("models.dev") ? catalogResponse({}) : catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await clineProvider.listModels!({ apiKey: "tok-abc" });

    expect(result).toEqual([
      "anthropic/claude-opus-5",
      "cline-free/deepseek-v4.1-flash",
      "cline-free/solar-pro4",
      "cline-pass/glm-5.3",
      "openai/gpt-6-astra",
    ]);

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("/api/v1/ai/cline/recommended-models");
    const options = call[1] as RequestInit;
    expect(options.headers).toMatchObject({
      authorization: "Bearer tok-abc",
      "X-CLIENT-TYPE": "cline-desktop",
      "X-Title": "Cline",
      "HTTP-Referer": "https://cline.bot",
    });
    expect(String((options.headers as Record<string, string>)["User-Agent"])).toMatch(
      /^Cline\//,
    );
  });

  it("caches the model list for thirty minutes", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("models.dev") ? catalogResponse({}) : catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await clineProvider.listModels!({});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
    const result = await clineProvider.listModels!({});
    expect(result.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, "now").mockReturnValue(time + 30 * 60 * 1000);
    await clineProvider.listModels!({});
    expect(fetchMock.mock.calls.filter(([url]) => !url.includes("models.dev"))).toHaveLength(2);
  });

  it("isolates account catalogs and shares concurrent fetches", async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("models.dev")) return catalogResponse({});
      const account = (options?.headers as Record<string, string>).authorization;
      return catalogResponse({ free: [{ id: account === "Bearer account-a" ? "future/a" : "future/b" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all([
      clineProvider.listModels!({ apiKey: "account-a" }),
      clineProvider.listModels!({ apiKey: "account-a" }),
      clineProvider.listModels!({ apiKey: "account-b" }),
    ]);
    expect(results).toEqual([["future/a"], ["future/a"], ["future/b"]]);
    expect(fetchMock.mock.calls.filter(([url]) => !url.includes("models.dev"))).toHaveLength(2);
  });

  it("restores capabilities on a cached listing and retains stale catalogs offline", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("models.dev")
      ? catalogResponse({})
      : catalogResponse({ free: [{ id: "future/offline", contextWindow: 524_288, maxTokens: 65_536, supportsReasoning: false }] }));
    vi.stubGlobal("fetch", fetchMock);
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    await clineProvider.listModels!({});
    clearModelCatalogFacts();
    await clineProvider.listModels!({});
    expect(modelCatalogFacts("cline", "future/offline")?.contextTokens).toBe(524_288);
    now.mockReturnValue(baseTime + 31 * 60 * 1000);
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(clineProvider.listModels!({})).resolves.toEqual(["future/offline"]);
    expect(modelCatalogFacts("cline", "future/offline")?.reasoning?.supported).toBe(false);
  });

  it("does not hide authentication failures behind a cached catalog", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("models.dev") ? catalogResponse({}) : catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    await clineProvider.listModels!({ apiKey: "invalid-token" });
    now.mockReturnValue(baseTime + 31 * 60 * 1000);
    fetchMock.mockImplementation(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));
    await expect(clineProvider.listModels!({ apiKey: "invalid-token" })).rejects.toThrow(/Unauthorized/);
  });

  it("ping verifies the token via /users/me", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: "usr-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(clineProvider.ping({ apiKey: "tok-abc" })).resolves.toBeUndefined();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("/api/v1/users/me");
  });

  it("ping throws an auth error without a key", async () => {
    await expect(clineProvider.ping({})).rejects.toThrow(/authentication required/i);
  });
});
