import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotProvider } from "../src/llm/copilot.js";
import {
  invalidateCopilotApiToken,
  parseCopilotCredentialFile,
} from "../src/llm/copilot-auth.js";

const GITHUB_TOKEN = "ghu_copilotmodelstest00000000000000";

function tokenExchangeResponse() {
  return new Response(
    JSON.stringify({
      token: "tid=test-model-catalog;exp=9999999999;sku=test",
      expires_at: 9999999999,
      refresh_in: 1500,
      endpoints: { api: "https://api.githubcopilot.com" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const catalog = {
  object: "list",
  data: [
    { id: "gpt-4o", name: "GPT-4o", vendor: "OpenAI" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", vendor: "Anthropic" },
    { id: "gpt-4o-mini", name: "GPT-4o mini", vendor: "OpenAI" },
  ],
};

function catalogResponse() {
  return new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/copilot_internal/v2/token")) return tokenExchangeResponse();
    if (url.includes("/models")) return catalogResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("Copilot provider", () => {
  afterEach(() => {
    invalidateCopilotApiToken(GITHUB_TOKEN);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("exchanges the github token then lists the catalog with client headers", async () => {
    const fetchMock = installFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await copilotProvider.listModels!({ apiKey: GITHUB_TOKEN });

    expect(result).toEqual(["claude-sonnet-4.5", "gpt-4o", "gpt-4o-mini"]);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("/copilot_internal/v2/token");
    expect(urls[1]).toContain("/models");
    const modelsCall = fetchMock.mock.calls[1]!;
    const options = modelsCall[1] as RequestInit;
    expect(options.headers).toMatchObject({
      authorization: "Bearer tid=test-model-catalog;exp=9999999999;sku=test",
      "Copilot-Integration-Id": "vscode-chat",
      "OpenAI-Organization": "github-copilot",
    });
    expect(String((options.headers as Record<string, string>)["User-Agent"])).toMatch(
      /^GitHubCopilotChat\//,
    );
  });

  it("caches the model list for an hour", async () => {
    const fetchMock = installFetch();
    vi.stubGlobal("fetch", fetchMock);
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await copilotProvider.listModels!({ apiKey: GITHUB_TOKEN });
    const firstCount = fetchMock.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
    const result = await copilotProvider.listModels!({ apiKey: GITHUB_TOKEN });
    expect(result.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBe(firstCount);
  });

  it("ping verifies the credential via /models", async () => {
    const fetchMock = installFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(copilotProvider.ping({ apiKey: GITHUB_TOKEN })).resolves.toBeUndefined();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/models"))).toBe(true);
  });

  it("ping throws an auth error without a key", async () => {
    await expect(copilotProvider.ping({})).rejects.toThrow(/authentication required/i);
  });

  it("validates only github-issued tokens", async () => {
    expect(copilotProvider.validateKey(GITHUB_TOKEN)).toBe(true);
    expect(copilotProvider.validateKey("gho_valid0000000000000000000000000000")).toBe(true);
    expect(copilotProvider.validateKey("sk-bad")).toBe(false);
    expect(copilotProvider.validateKey("workos:some-other-token")).toBe(false);
  });

  it("parses apps.json entries preferring ghu_ tokens", async () => {
    expect(
      parseCopilotCredentialFile({
        "github.com:Iv1.b507a08c87ecfe98": {
          user: "someone",
          oauth_token: GITHUB_TOKEN,
          githubAppId: "Iv1.b507a08c87ecfe98",
        },
      }),
    ).toBe(GITHUB_TOKEN);
    expect(parseCopilotCredentialFile({})).toBeUndefined();
    expect(parseCopilotCredentialFile([])).toBeUndefined();
  });
});
