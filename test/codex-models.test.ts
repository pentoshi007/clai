import { afterEach, describe, expect, it, vi } from "vitest";
import { codexProvider } from "../src/llm/codex.js";
import { encodeCodexKey } from "../src/llm/codex-auth.js";

const ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

function testKey(accessToken = "acc-test-0000000000"): string {
  return encodeCodexKey({ accessToken, accountId: ACCOUNT_ID });
}

const catalog = {
  models: [
    { slug: "gpt-5.1-codex", display_name: "GPT 5.1 Codex" },
    { slug: "gpt-5.1", display_name: "GPT 5.1" },
    { slug: "o3", display_name: "o3" },
  ],
};

function catalogResponse() {
  return new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Codex provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("lists the slug catalog and sends Codex client headers", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await codexProvider.listModels!({ apiKey: testKey() });

    expect(result).toEqual(["gpt-5.1", "gpt-5.1-codex", "o3"]);

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("/backend-api/codex/models");
    expect(String(call[0])).toContain("client_version=");
    const options = call[1] as RequestInit;
    expect(options.headers).toMatchObject({
      authorization: "Bearer acc-test-0000000000",
      "chatgpt-account-id": ACCOUNT_ID,
      originator: "codex_cli_rs",
    });
    expect(String((options.headers as Record<string, string>)["User-Agent"])).toMatch(
      /^codex_cli_rs\//,
    );
  });

  it("caches the model list for an hour", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await codexProvider.listModels!({ apiKey: testKey() });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
    const result = await codexProvider.listModels!({ apiKey: testKey() });
    expect(result.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ping verifies the credential via /models", async () => {
    const fetchMock = vi.fn(async () => catalogResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(codexProvider.ping({ apiKey: testKey() })).resolves.toBeUndefined();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("/backend-api/codex/models");
  });

  it("ping throws an auth error without a key", async () => {
    await expect(codexProvider.ping({})).rejects.toThrow(/authentication required/i);
  });

  it("validates only well-formed encoded credentials", async () => {
    expect(codexProvider.validateKey(testKey())).toBe(true);
    expect(codexProvider.validateKey("garbage")).toBe(false);
    expect(codexProvider.validateKey("codex:!!!not-base64!!!")).toBe(false);
    expect(codexProvider.validateKey("workos:some-other-provider-token")).toBe(false);
  });
});
