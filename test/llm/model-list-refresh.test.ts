import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeProvider, resetFreeModelCacheForTesting } from "../../src/llm/free.js";
import { resetFreeDefaultModelCache } from "../../src/llm/free-default-model.js";
import { listProviderModels } from "../../src/llm/model-discovery.js";
import {
  invalidateModelLists,
  isFallbackModelList,
  MODEL_LIST_TTL_MS,
} from "../../src/llm/model-list-cache.js";
import { nvidiaFallbackModels, resetNvidiaModelCatalogCache } from "../../src/llm/nvidia.js";
import { resetZenCatalogForTesting } from "../../src/llm/zen-catalog.js";

const START = 1_900_000_000_000;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function catalog(ids: readonly string[]): Response {
  return json({ data: ids.map((id) => ({ id })) });
}

beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-modellistrefresh0123456789");
  vi.stubEnv("NVIDIA_API_KEY", "nvapi-modellistrefresh0123456789");
  vi.spyOn(Date, "now").mockReturnValue(START);
  invalidateModelLists();
  resetNvidiaModelCatalogCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateModelLists();
});

function at(offsetMs: number): void {
  vi.mocked(Date.now).mockReturnValue(START + offsetMs);
}

describe("model lists through provider discovery", () => {
  it("serves a repeat request from the cache and refetches once two minutes have passed", async () => {
    const fetchMock = vi.fn(async () => catalog(["deepseek-chat"]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    at(MODEL_LIST_TTL_MS - 1);
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    at(MODEL_LIST_TTL_MS);
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches again on refresh even though the cached list is still fresh", async () => {
    let live = ["deepseek-chat"];
    const fetchMock = vi.fn(async () => catalog(live));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    live = ["deepseek-chat", "deepseek-new"];
    at(10_000);
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    expect(await listProviderModels("deepseek", { refresh: true })).toEqual(["deepseek-chat", "deepseek-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat", "deepseek-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a request that is already in flight when refreshing", async () => {
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          const index = releases.length;
          releases.push(() => resolve(catalog([index === 0 ? "stale-in-flight" : "fresh-after-refresh"])));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = listProviderModels("deepseek");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const refreshed = listProviderModels("deepseek", { refresh: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    releases[1]!();
    expect(await refreshed).toEqual(["fresh-after-refresh"]);
    releases[0]!();
    expect(await first).toEqual(["stale-in-flight"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers that did not ask for a refresh", async () => {
    let release: () => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(catalog(["deepseek-chat"]));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = listProviderModels("deepseek");
    const second = listProviderModels("deepseek");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual(["deepseek-chat"]);
    expect(await second).toEqual(["deepseek-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never remembers a failed fetch", async () => {
    let online = false;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new Error("network down");
      return catalog(["deepseek-chat"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listProviderModels("deepseek")).rejects.toThrow("network down");
    await expect(listProviderModels("deepseek")).rejects.toThrow("network down");
    online = true;
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never remembers an empty answer", async () => {
    let ids: string[] = [];
    const fetchMock = vi.fn(async () => catalog(ids));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listProviderModels("deepseek")).toEqual([]);
    ids = ["deepseek-chat"];
    expect(await listProviderModels("deepseek")).toEqual(["deepseek-chat"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("providers that answer with their built-in list when the fetch fails", () => {
  it("labels the built-in list and returns to the live catalog as soon as the network does", async () => {
    let online = false;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new Error("network down");
      return catalog(["nvidia/live-model"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const offline = await listProviderModels("nvidia");
    expect(isFallbackModelList(offline)).toBe(true);
    expect(offline).toEqual([...nvidiaFallbackModels]);

    online = true;
    const live = await listProviderModels("nvidia");
    expect(isFallbackModelList(live)).toBe(false);
    expect(live).toEqual(["nvidia/live-model"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last live list through a short outage but drops it when the user refreshes", async () => {
    let online = true;
    const fetchMock = vi.fn(async () => {
      if (!online) throw new Error("network down");
      return catalog(["nvidia/live-model"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await listProviderModels("nvidia");
    online = false;
    at(MODEL_LIST_TTL_MS + 1);
    const outage = await listProviderModels("nvidia");
    expect(isFallbackModelList(outage)).toBe(false);
    expect(outage).toEqual(["nvidia/live-model"]);

    const refreshed = await listProviderModels("nvidia", { refresh: true });
    expect(isFallbackModelList(refreshed)).toBe(true);
  });
});

describe("the Free provider", () => {
  const ZEN = "https://opencode.ai/zen/v1/models";
  const KILO = "https://api.kilo.ai/api/gateway/models";
  const CATALOG = "https://models.opencode.ai/api.json";

  beforeEach(() => {
    resetFreeModelCacheForTesting();
    resetFreeDefaultModelCache();
    resetZenCatalogForTesting();
  });

  it("is not stuck on its built-in list for the retry cooldown after the network returns", async () => {
    let online = false;
    const fetchMock = vi.fn(async (input: unknown) => {
      if (!online) throw new Error("network down");
      const url = String(input);
      if (url === CATALOG) {
        return json({ opencode: { api: "https://opencode.ai/zen/v1", models: { "hy3-free": { cost: { input: 0, output: 0 } } } } });
      }
      if (url === ZEN) return catalog(["hy3-free"]);
      if (url === KILO) return json({ data: [{ id: "kilo-auto/free", isFree: true }] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const offline = await freeProvider.listModels!({});
    expect(isFallbackModelList(offline)).toBe(true);

    at(1_000);
    online = true;
    const live = await freeProvider.listModels!({});
    expect(isFallbackModelList(live)).toBe(false);
    expect(live).toContain("free-1/hy3-free");
    expect(live).toContain("free-2/kilo-auto/free");
  });

  it("drops the retry cooldown and the cached catalogs on refresh", async () => {
    let ids = ["hy3-free"];
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === CATALOG) {
        return json({ opencode: { api: "https://opencode.ai/zen/v1", models: Object.fromEntries(ids.map((id) => [id, { cost: { input: 0, output: 0 } }])) } });
      }
      if (url === ZEN) return catalog(ids);
      if (url === KILO) return json({ data: [{ id: "kilo-auto/free", isFree: true }] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await freeProvider.listModels!({});
    ids = ["hy3-free", "mimo-free"];
    at(5_000);
    expect(await freeProvider.listModels!({})).not.toContain("free-1/mimo-free");
    expect(await listProviderModels("free", { refresh: true })).toContain("free-1/mimo-free");
  });
});
