import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { hinokiProvider, resetHinokiModelCatalogCache } from "../../src/llm/hinoki.js";
import { listProviderModels } from "../../src/llm/model-discovery.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import { markProviderKeySuccess } from "../../src/store/keys.js";
import { ENTRY, MODEL, REQUEST, USAGE, json, sse } from "./hinoki-fixtures.js";

const state = vi.hoisted(() => ({
  keys: [] as ProviderKeySlot[],
  activeIndex: 0,
}));
const KEYS = ["hinoki-fixture-first-credential", "hinoki-fixture-second-credential"];

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => provider === "hinoki"
      ? { keys: state.keys, activeIndex: state.activeIndex, source: "fallback" as const }
      : { keys: [], activeIndex: 0, source: "missing" as const },
    getProviderSecret: async () => ({ value: KEYS[0], source: "fallback" as const }),
    markProviderKeySuccess: vi.fn(async () => undefined),
    setProviderKeys: vi.fn(async () => "fallback" as const),
  };
});
vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({ ...actual.getConfig(), defaultProvider: "hinoki", defaultModel: "hinoki-offensive", providerFallback: false, freeOnly: false }),
    getActiveProviderEndpoint: () => undefined,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
  };
});

const OPTIONS = { maxRetries: 0, retryRateLimits: false, allowProviderFallback: false, adoptFallback: false };
beforeEach(() => {
  state.keys = KEYS.map((value, index) => ({ id: `hinoki-${index}`, value, createdAt: 0 }));
  state.activeIndex = 0;
  resetHinokiModelCatalogCache();
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  vi.mocked(markProviderKeySuccess).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function install(status: number, failCatalog = false, stream = false) {
  const used: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    used.push(authorization);
    const catalog = String(url).endsWith("/models");
    if (authorization === `Bearer ${KEYS[0]}` && (failCatalog || !catalog)) {
      return json({ error: { message: status === 402 ? "insufficient credits" : status === 429 ? "rate limited" : "invalid credentials" } }, status);
    }
    if (catalog) return json({ data: [ENTRY] });
    return stream
      ? sse([{ choices: [{ delta: { content: "rotated-ok" }, finish_reason: "stop" }] }, { choices: [], usage: USAGE }])
      : json({ choices: [{ message: { content: "rotated-ok" }, finish_reason: "stop" }], usage: USAGE });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { used, fetchMock };
}

describe.each(["complete", "stream"] as const)("Hinoki %s multi-key lifecycle", (mode) => {
  it.each([401, 402, 403, 429])("rotates after HTTP %i and reports only the successful usage", async (status) => {
    const { used } = install(status, false, mode === "stream");
    const statuses: string[] = [];
    const options = { ...OPTIONS, onStatus: (text: string) => statuses.push(text) };
    const result = mode === "complete"
      ? await completeWithProvider(REQUEST, options)
      : await streamWithProvider(REQUEST, () => {}, options);
    expect(result).toMatchObject({ provider: "hinoki", model: MODEL, text: "rotated-ok", usage: { promptTokens: 120, completionTokens: 30 } });
    expect(used).toContain(`Bearer ${KEYS[1]}`);
    expect(markProviderKeySuccess).toHaveBeenCalledWith("hinoki", 1);
    expect(statuses.join("\n")).not.toContain(KEYS[0]);
    expect(statuses.join("\n")).not.toContain(KEYS[1]);
  });
});

describe("Hinoki discovery, sticky selection and auxiliary affinity", () => {
  it("rotates discovery keys after catalog authentication failure", async () => {
    const { used } = install(401, true);
    expect(await listProviderModels("hinoki", { refresh: true })).toEqual([MODEL]);
    expect(used).toEqual(KEYS.map((key) => `Bearer ${key}`));
  });

  it("skips disabled keys and uses the selected slot", async () => {
    state.keys[0]!.disabled = true;
    const { used } = install(401);
    expect((await completeWithProvider(REQUEST, OPTIONS)).text).toBe("rotated-ok");
    expect(used.every((value) => value === `Bearer ${KEYS[1]}`)).toBe(true);
    state.keys[0]!.disabled = false;
    state.activeIndex = 1;
    resetHinokiModelCatalogCache();
    used.length = 0;
    await completeWithProvider(REQUEST, OPTIONS);
    expect(used.every((value) => value === `Bearer ${KEYS[1]}`)).toBe(true);
  });

  it("rejects all-disabled keys without network requests", async () => {
    for (const slot of state.keys) slot.disabled = true;
    const { fetchMock } = install(401);
    await expect(completeWithProvider(REQUEST, OPTIONS)).rejects.toThrow(/disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not rotate for malformed requests", async () => {
    const { used } = install(422);
    await expect(completeWithProvider(REQUEST, OPTIONS)).rejects.toThrow();
    expect(used).not.toContain(`Bearer ${KEYS[1]}`);
  });

  it("keeps the real provider registered under shared routing", () => {
    expect(hinokiProvider.id).toBe("hinoki");
  });
});
