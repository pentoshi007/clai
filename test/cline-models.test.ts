import { afterEach, describe, expect, it, vi } from "vitest";
import { clineProvider } from "../src/llm/cline.js";

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

function catalogResponse() {
  return new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Cline provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("lists the flattened catalog and sends desktop client headers", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await clineProvider.listModels!({ apiKey: "tok-abc" });

    // flattened recommended + free + clinePass, deduped + sorted
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

  it("caches the model list for an hour", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await clineProvider.listModels!({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
    const result = await clineProvider.listModels!({});
    expect(result.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
