import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeCustomProvider } from "../../src/llm/custom-providers.js";
import type { CustomProviderApi } from "../../src/llm/custom-providers.js";

const APIS: readonly CustomProviderApi[] = ["chat-completions", "responses", "anthropic-messages"];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom model discovery", () => {
  it.each(APIS)("authenticates and bounds %s discovery", async (api) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authenticated = api === "anthropic-messages"
        ? headers.get("x-api-key") === "fixture-custom-key"
        : headers.get("authorization") === "Bearer fixture-custom-key";
      return Response.json(authenticated ? { data: [{ id: "live-model", context_length: 200_000 }] } : { error: "missing credentials" }, { status: authenticated ? 200 : 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = materializeCustomProvider({ id: `fixture-${api}`, displayName: "Fixture", baseUrl: "https://fixture.example/v1", defaultModel: "", api });
    expect(await provider.listModels!({ apiKey: "fixture-custom-key" })).toEqual(["live-model"]);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://fixture.example/v1/models");
  });

  it.each(APIS)("exposes %s catalog failures instead of silently returning an empty catalog", async (api) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Invalid credential" } }, { status: 401 })));
    const provider = materializeCustomProvider({ id: `failure-${api}`, displayName: "Fixture", baseUrl: "https://fixture.example/v1", defaultModel: "", api });
    await expect(provider.listModels!({ apiKey: "fixture-custom-key" })).rejects.toThrow(/401/);
  });

  it("supports intentionally keyless discovery", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ data: ["public-model"] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = materializeCustomProvider({ id: "fixture-public", displayName: "Public", baseUrl: "https://fixture.example/v1", defaultModel: "", api: "chat-completions", profile: { authType: "none-keyless" } });
    expect(await provider.listModels!({})).toEqual(["public-model"]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("uses the same deadline and authentication for every Anthropic page", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const second = new URL(String(input)).searchParams.has("after_id");
      return Response.json({ data: [{ id: second ? "second" : "first" }], has_more: !second, last_id: second ? "second" : "first" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = materializeCustomProvider({ id: "fixture-paged", displayName: "Paged", baseUrl: "https://fixture.example/v1", defaultModel: "", api: "anthropic-messages" });
    expect(await provider.listModels!({ apiKey: "fixture-custom-key" })).toEqual(["first", "second"]);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(fetchMock.mock.calls[0]?.[1]?.signal);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("anthropic-version")).toBe("2023-06-01");
  });
});
