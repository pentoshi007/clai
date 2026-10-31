import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import type { ProviderId } from "../../src/types.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { prefetchProviderCatalog, resetCatalogPrefetchState } from "../../src/llm/catalog-prefetch.js";
import { getProvider } from "../../src/llm/router.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { handleModel, handleProvider, resolveModelsForProvider } from "../../src/ui-core/commands/picker-commands.js";
import { releaseSessionModel } from "../../src/store/session-model.js";
import { stubRiverFetch } from "../llm/river-fixtures.js";

const state = vi.hoisted(() => ({
  keys: [] as ProviderKeySlot[],
  activeIndex: 0,
  endpoints: [] as string[],
  disabledEndpoints: [] as string[],
  activeEndpointIndex: 0,
  environmentEndpoint: undefined as string | undefined,
  saveKey: vi.fn(),
}));
vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => provider === "river"
      ? { keys: state.keys, activeIndex: state.activeIndex, source: "fallback" as const }
      : actual.getProviderKeys(provider),
    getProviderSecret: async (provider: ProviderId) => {
      if (provider !== "river") return actual.getProviderSecret(provider);
      const ordered = [...state.keys.slice(state.activeIndex), ...state.keys.slice(0, state.activeIndex)];
      return { value: ordered.find(key => !key.disabled)?.value, source: "fallback" as const };
    },
    setProviderSecret: async (provider: ProviderId, value: string) => {
      if (provider !== "river") return actual.setProviderSecret(provider, value);
      state.saveKey(provider, value);
      state.keys = [{ id: "added", value, createdAt: 0 }];
      return "fallback" as const;
    },
  };
});
vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getProviderEndpoints: (provider: ProviderId) => provider === "river"
      ? { urls: state.endpoints, activeIndex: state.activeEndpointIndex, disabledUrls: state.disabledEndpoints }
      : actual.getProviderEndpoints(provider),
    getActiveProviderEndpoint: (provider: ProviderId) => {
      if (provider !== "river") return actual.getActiveProviderEndpoint(provider);
      if (state.environmentEndpoint) return state.environmentEndpoint;
      const ordered = [...state.endpoints.slice(state.activeEndpointIndex), ...state.endpoints.slice(0, state.activeEndpointIndex)];
      return ordered.find(url => !state.disabledEndpoints.includes(url)) ?? "";
    },
  };
});

vi.mock("../../src/llm/catalog-prefetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/llm/catalog-prefetch.js")>();
  return {
    ...actual,
    prefetchProviderCatalog: (provider: ProviderId | undefined, options?: { now?: number }) => provider === "river"
      ? actual.prefetchProviderCatalog(provider, options) : Promise.resolve(),
  };
});

const liveModels = ["river-live-regression-1", "river-live-regression-2"];
const active = new Set<AppServices>();
let modelDir: string;
let sequence = 0;

beforeEach(() => {
  state.keys = [
    { id: "first", value: `rv_discovery_first_${++sequence}`, createdAt: 0 },
    { id: "second", value: `rv_discovery_second_${sequence}`, createdAt: 0 },
  ];
  state.activeIndex = 0;
  state.endpoints = [];
  state.disabledEndpoints = [];
  state.activeEndpointIndex = 0;
  state.environmentEndpoint = undefined;
  state.saveKey.mockReset();
  modelDir = mkdtempSync(join(tmpdir(), "river-discovery-"));
  vi.stubEnv("CLAI_SESSION_MODEL_DIR", modelDir);
  vi.stubEnv("RIVER_API_KEY", undefined);
  vi.stubEnv("RIVER_BASE_URL", undefined);
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  resetCatalogPrefetchState();
});

afterEach(async () => {
  for (const services of active) {
    const provider = services.session.getState().provider;
    services.dispose();
    if (provider === "river") await prefetchProviderCatalog("river");
    await releaseSessionModel(services.session.sessionId);
  }
  active.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  resetCatalogPrefetchState();
  await rm(modelDir, { recursive: true, force: true });
});

function setup() {
  const services = createCompositionRoot({
    agent: { runTurn: async () => createTurnOutcome({ status: "succeeded", answer: "", steps: 0, remainingCriteria: [] }) },
    persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
  });
  active.add(services);
  return services;
}

function catalog() {
  return Response.json({ data: liveModels.map(id => ({ id })) });
}

function rejected(key: string) {
  return Response.json({ error: { message: `Invalid API key: ${key}` } }, { status: 401 });
}

function recoveringTransport() {
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    return authorization === `Bearer ${state.keys[0]!.value}` ? rejected(state.keys[0]!.value) : catalog();
  });
  stubRiverFetch(fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe("live River model discovery recovery", () => {
  it("fetches dynamic IDs with the next enabled key after the active key is rejected", async () => {
    const fetchMock = recoveringTransport();
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url, init]) => String(url).endsWith("/models") && (!init?.method || init.method === "GET"))).toBe(true);
  });

  it("recovers a transient catalog 401 with one configured key", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected(state.keys[0]!.value)).mockImplementation(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers multiple consecutive catalog 401s without replacing the live model list", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected(state.keys[0]!.value))
      .mockResolvedValueOnce(rejected(state.keys[0]!.value))
      .mockImplementation(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops auth rechecks when the catalog returns a different failure", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected(state.keys[0]!.value))
      .mockImplementation(async () => Response.json({ error: "Unavailable" }, { status: 503 }));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const result = await resolveModelsForProvider("river");
    expect(result.source).toBe("known");
    expect(result.error).toContain("503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tries enabled alternate endpoints without sending inference requests", async () => {
    state.keys = state.keys.slice(0, 1);
    state.endpoints = ["https://rejected.example/v1", "https://disabled.example/v1", "https://working.example/v1"];
    state.disabledEndpoints = [state.endpoints[1]!];
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes("working.example") ? catalog() : rejected(state.keys[0]!.value));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://rejected.example/v1/models", "https://working.example/v1/models",
    ]);
  });

  it("skips disabled keys and starts from the active key", async () => {
    state.keys.unshift({ id: "disabled", value: "rv_disabled", createdAt: 0, disabled: true });
    state.activeIndex = 1;
    const fetchMock = recoveringTransport();
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([`Bearer ${state.keys[1]!.value}`]);
  });

  it("does not bypass an explicit environment endpoint when a stored endpoint would succeed", async () => {
    state.keys = state.keys.slice(0, 1);
    state.endpoints = ["https://stored.example/v1"];
    state.environmentEndpoint = "https://override.example/v1";
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes("stored.example") ? catalog() : rejected(state.keys[0]!.value));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const result = await resolveModelsForProvider("river");
    expect(result.source).toBe("known");
    expect(result.error).toContain("401");
    expect(fetchMock.mock.calls.every(([url]) => String(url) === "https://override.example/v1/models")).toBe(true);
  });

  it("keeps permanent catalog failures visible and redacts credentials", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn(async () => rejected(state.keys[0]!.value));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const result = await resolveModelsForProvider("river");
    expect(result.source).toBe("known");
    expect(result.error).toContain("401");
    expect(result.error).not.toContain(state.keys[0]!.value);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not turn a malformed request into repeated catalog calls", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Bad request" }, { status: 400 }));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect((await resolveModelsForProvider("river")).error).toContain("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["keys", "endpoints"] as const)("does not fetch when all configured %s are disabled", async (disabled) => {
    if (disabled === "keys") state.keys = state.keys.map(key => ({ ...key, disabled: true }));
    else {
      state.endpoints = ["https://disabled.example/v1"];
      state.disabledEndpoints = [...state.endpoints];
    }
    const fetchMock = vi.fn(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const result = await resolveModelsForProvider("river");
    expect(result.source).toBe("known");
    expect(result.error).toContain("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("populates the shared model picker with recovered live IDs without an auth warning", async () => {
    recoveringTransport();
    const services = setup();
    services.session.setProvider("river");
    const notice = vi.spyOn(services.session, "notice");
    await handleModel(services, { name: "model", args: "" });
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") throw new Error("Model picker did not open");
    expect(overlay.request.title).toBe("Models · River · live");
    expect(overlay.request.options.map(option => option.value)).toEqual(liveModels);
    expect(notice.mock.calls.some(([kind]) => kind === "warn")).toBe(false);
  });

  it("fetches live models after adding a key through the provider onboarding flow", async () => {
    state.keys = [];
    const services = setup();
    vi.spyOn(services.overlay, "openSecret").mockResolvedValue("rv_newly_added");
    const notice = vi.spyOn(services.session, "notice");
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected("rv_newly_added")).mockImplementation(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    handleProvider(services, { name: "provider", args: "river" });
    await vi.waitFor(() => {
      const overlay = services.overlay.getState();
      expect(overlay.kind).toBe("picker");
      if (overlay.kind !== "picker") throw new Error("Model picker did not open");
      expect(overlay.request.title).toBe("Models · River · live");
      expect(overlay.request.options.map(option => option.value)).toEqual(liveModels);
    }, { timeout: 5_000 });
    expect(state.saveKey).toHaveBeenCalledWith("river", "rv_newly_added");
    expect(notice.mock.calls.some(([kind]) => kind === "warn")).toBe(false);
  });

  it("uses the same recovered catalog route for background prefetch", async () => {
    const fetchMock = recoveringTransport();
    await prefetchProviderCatalog("river");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(`Bearer ${state.keys[1]!.value}`);
  });

  it("coalesces foreground and background recovery for the same credentials", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn().mockResolvedValueOnce(rejected(state.keys[0]!.value)).mockImplementation(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const [first, , second] = await Promise.all([
      resolveModelsForProvider("river"), prefetchProviderCatalog("river"), resolveModelsForProvider("river"),
    ]);
    expect(first).toEqual({ models: liveModels, source: "live" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not join an in-flight discovery started with a different listModels binding", async () => {
    state.keys = state.keys.slice(0, 1);
    const gate = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async () => {
      await gate.promise;
      return catalog();
    });
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const first = resolveModelsForProvider("river");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const spy = vi.spyOn(getProvider("river"), "listModels").mockResolvedValue(["river-mocked-live"]);
    try {
      expect(await resolveModelsForProvider("river")).toEqual({ models: ["river-mocked-live"], source: "live" });
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
    expect(await first).toEqual({ models: liveModels, source: "live" });
  });

  it("does not coalesce catalogs across changed credentials", async () => {
    state.keys = state.keys.slice(0, 1);
    const original = state.keys[0]!.value;
    const gate = Promise.withResolvers<void>();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const oldCredential = new Headers(init?.headers).get("authorization") === `Bearer ${original}`;
      if (oldCredential) await gate.promise;
      return Response.json({ data: [{ id: oldCredential ? "river-original-live" : "river-replacement-live" }] });
    });
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const first = resolveModelsForProvider("river");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    state.keys = [{ id: "replacement", value: "rv_changed_credential", createdAt: 1 }];
    const second = resolveModelsForProvider("river");
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(await second).toEqual({ models: ["river-replacement-live"], source: "live" });
    } finally {
      gate.resolve();
    }
    expect(await first).toEqual({ models: ["river-original-live"], source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a rejected discovery after the API becomes available", async () => {
    state.keys = state.keys.slice(0, 1);
    let available = false;
    const fetchMock = vi.fn(async () => available ? catalog() : rejected(state.keys[0]!.value));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect((await resolveModelsForProvider("river")).source).toBe("known");
    available = true;
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("wraps key and endpoint order and tries every enabled route", async () => {
    state.activeIndex = 1;
    state.endpoints = ["https://working.example/v1", "https://rejected.example/v1"];
    state.activeEndpointIndex = 1;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return String(input).includes("working.example") && authorization === `Bearer ${state.keys[0]!.value}`
        ? catalog() : rejected("rv_fixture_rejection");
    });
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get("authorization")])).toEqual([
      ["https://rejected.example/v1/models", `Bearer ${state.keys[1]!.value}`],
      ["https://rejected.example/v1/models", `Bearer ${state.keys[0]!.value}`],
      ["https://working.example/v1/models", `Bearer ${state.keys[1]!.value}`],
      ["https://working.example/v1/models", `Bearer ${state.keys[0]!.value}`],
    ]);
  });

  it("reloads a changed credential before rechecking a single-key catalog rejection", async () => {
    state.keys = state.keys.slice(0, 1);
    const original = state.keys[0]!.value;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${original}`) {
        state.keys = [{ id: "replacement", value: "rv_reloaded_key", createdAt: 1 }];
        return rejected(original);
      }
      return catalog();
    });
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect(await resolveModelsForProvider("river")).toEqual({ models: liveModels, source: "live" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer rv_reloaded_key");
  });

  it("does not start another catalog request after the recovery window expires", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const fetchMock = vi.fn(async () => {
      clock.mockReturnValue(started + 15_001);
      return rejected(state.keys[0]!.value);
    });
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    const result = await resolveModelsForProvider("river");
    expect(result.source).toBe("known");
    expect(result.error).toContain("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permanent single-key permission rejection", async () => {
    state.keys = state.keys.slice(0, 1);
    const fetchMock = vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 }));
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    expect((await resolveModelsForProvider("river")).error).toContain("403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not save a key or fetch models after onboarding is cancelled", async () => {
    state.keys = [];
    const services = setup();
    vi.spyOn(services.overlay, "openSecret").mockResolvedValue(undefined);
    const notice = vi.spyOn(services.session, "notice");
    const fetchMock = vi.fn(async () => catalog());
    stubRiverFetch(fetchMock as unknown as typeof fetch);
    handleProvider(services, { name: "provider", args: "river" });
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("info", "cancelled · provider unchanged"));
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
