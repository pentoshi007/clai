import { afterEach, describe, expect, it, vi } from "vitest";
import { openrouterProvider } from "../src/llm/openrouter.js";

describe("OpenRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "google/gemini-2.5-flash" }, { id: "meta-llama/llama-3.3-70b-instruct:free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await openrouterProvider.listModels!({ apiKey: "test-key" });
    expect(result).toEqual([
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct:free",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/api/v1/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer test-key",
      "HTTP-Referer": "https://github.com/clai/clai",
      "X-Title": "clai",
    });
  });

  it("works without an API key (public endpoint)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "google/gemini-2.5-flash" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 2 hours after baseTime
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    const result = await openrouterProvider.listModels!({});
    expect(result).toEqual(["google/gemini-2.5-flash"]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).not.toHaveProperty("authorization");
    expect(options.headers).toMatchObject({
      "HTTP-Referer": "https://github.com/clai/clai",
      "X-Title": "clai",
    });
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "google/gemini-2.5-flash" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 5 hours after baseTime
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await openrouterProvider.listModels!({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL (10 seconds later)
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await openrouterProvider.listModels!({});
    expect(result).toEqual(["google/gemini-2.5-flash"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
