import { afterEach, describe, expect, it, vi } from "vitest";
import { bynaraProvider } from "../src/llm/bynara.js";

describe("Bynara model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }, { id: "mimo-v2.5-pro-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await bynaraProvider.listModels!({ apiKey: "test-key" });
    expect(result).toEqual([
      "mimo-v2.5-free",
      "mimo-v2.5-pro-free",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer test-key",
    });
  });

  it("works without an API key (public endpoint)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 2 hours after baseTime
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    const result = await bynaraProvider.listModels!({});
    expect(result).toEqual(["mimo-v2.5-free"]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).not.toHaveProperty("authorization");
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 5 hours after baseTime
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await bynaraProvider.listModels!({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL (10 seconds later)
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await bynaraProvider.listModels!({});
    expect(result).toEqual(["mimo-v2.5-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
