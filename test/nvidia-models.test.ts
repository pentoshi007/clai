import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelContextWindow } from "../src/llm/context-windows.js";
import {
  nvidiaProvider,
  nvidiaFallbackModels,
  resetNvidiaModelCatalogCache,
} from "../src/llm/nvidia.js";

describe("NVIDIA NIM model discovery", () => {
  beforeEach(() => resetNvidiaModelCatalogCache());

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetNvidiaModelCatalogCache();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "meta/llama-3.3-70b-instruct", max_model_len: 77_777 },
        { id: "deepseek-ai/deepseek-v4-pro" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await nvidiaProvider.listModels!({ apiKey: "nvapi-testkey12345678" });
    // Returned models are sorted alphabetically
    expect(result).toEqual([
      "deepseek-ai/deepseek-v4-pro",
      "meta/llama-3.3-70b-instruct",
    ]);
    expect(modelContextWindow("meta/llama-3.3-70b-instruct", "nvidia")).toBe(77_777);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/v1/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer nvapi-testkey12345678",
    });
  });

  it("falls back to capabilities models on fetch failure", async () => {
    const fetchMock = vi.fn(async () => new Response("Internal Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    // Set time 2 hours after baseTime to bypass cache
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    const result = await nvidiaProvider.listModels!({ apiKey: "nvapi-testkey12345678" });
    expect(result).toEqual(nvidiaFallbackModels);
  });

  it("falls back immediately if no api key is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await nvidiaProvider.listModels!({});
    expect(result).toEqual(nvidiaFallbackModels);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "meta/llama-3.3-70b-instruct" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await nvidiaProvider.listModels!({ apiKey: "nvapi-testkey12345678" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await nvidiaProvider.listModels!({ apiKey: "nvapi-testkey12345678" });
    expect(result).toEqual(["meta/llama-3.3-70b-instruct"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
