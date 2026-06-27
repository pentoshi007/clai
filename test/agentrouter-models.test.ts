import { afterEach, describe, expect, it, vi } from "vitest";
import { agentrouterProvider } from "../src/llm/agentrouter.js";

describe("AgentRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("requires API key and calls fetch on agentrouter models endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-haiku-4-5-20251001" }, { id: "gpt-5" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(result).toEqual([
      "claude-haiku-4-5-20251001",
      "gpt-5",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer sk-testkey",
    });
  });

  it("throws when no API key is configured", async () => {
    await expect(agentrouterProvider.listModels!({})).rejects.toThrow(
      "AgentRouter API key is required",
    );
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-haiku-4-5-20251001" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 5 hours after baseTime
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL (10 seconds later)
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await agentrouterProvider.listModels!({ apiKey: "sk-testkey" });
    expect(result).toEqual(["claude-haiku-4-5-20251001"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
