import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenrouterProvider } from "../src/llm/tokenrouter.js";

describe("TokenRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "openai/gpt-5.4-nano" },
        { id: "qwen/qwen3.5-9b" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await tokenrouterProvider.listModels!({ apiKey: "tr-testkey12345678" });
    expect(result).toEqual([
      "openai/gpt-5.4-nano",
      "qwen/qwen3.5-9b",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer tr-testkey12345678",
    });
  });

  it("surfaces the fetch error instead of silently returning an empty list", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Invalid API key", type: "api_error" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass any cache from prior tests.
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    await expect(
      tokenrouterProvider.listModels!({ apiKey: "tr-badkey12345678" }),
    ).rejects.toThrow(/401/);
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "openai/gpt-5.4-nano" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await tokenrouterProvider.listModels!({ apiKey: "tr-cachekey12345678" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await tokenrouterProvider.listModels!({ apiKey: "tr-cachekey12345678" });
    expect(result).toEqual(["openai/gpt-5.4-nano"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
