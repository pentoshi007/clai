import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCatalogFacts } from "../../src/llm/catalog-facts.js";

const CATALOG_URL = "https://models.dev/api.json";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";
const START = 1_900_000_000_000;
let supplement: typeof import("../../src/llm/free-model-limits.js").supplementZenModelLimits;
let dataDir: string | undefined;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function catalog(models: Record<string, unknown>) {
  return { opencode: { api: ZEN_BASE_URL, models } };
}

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(Date, "now").mockReturnValue(START);
  ({ supplementZenModelLimits: supplement } = await import("../../src/llm/free-model-limits.js"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("OpenCode Zen serving limits", () => {
  it("uses exact provider entries without adding models or capabilities", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(catalog({
      "exo-free": {
        id: "exo-free",
        limit: { context: 1_048_576, output: 131_072 },
        reasoning: true,
        modalities: { input: ["text", "image"] },
      },
      "unavailable-free": { limit: { context: 2_000_000, output: 128_000 } },
      "unknown": { limit: { context: 4_000_000, output: 256_000 } },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await supplement([{ id: "exo-free" }, "unknown-free"]);
    expect(result).toEqual([
      { id: "exo-free", context_length: 1_048_576, max_output_tokens: 131_072 },
      "unknown-free",
    ]);
    expect(parseCatalogFacts(result[0])?.reasoning).toBeUndefined();
    const [url, options] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(CATALOG_URL);
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("fills missing limits independently and preserves gateway values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(catalog({
      "context-free": { limit: { context: 1_000_000, output: 64_000 } },
      "output-free": { limit: { context: 262_144, output: 131_072 } },
    }))));
    const result = await supplement([
      { id: "context-free", top_provider: { context_length: 200_000 } },
      { id: "output-free", limit: { output: 32_000 } },
    ]);
    expect(parseCatalogFacts(result[0])).toMatchObject({ contextTokens: 200_000, maxOutputTokens: 64_000 });
    expect(parseCatalogFacts(result[1])).toMatchObject({ contextTokens: 262_144, maxOutputTokens: 32_000 });
  });

  it("avoids supplemental requests when the gateway supplies every limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const entries = [{ id: "known-free", context_length: 500_000, max_output_tokens: 64_000 }];
    expect(await supplement(entries)).toBe(entries);
    expect(await supplement([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads model catalogs larger than the standard four-megabyte response cap", async () => {
    const payload = {
      irrelevantProvider: { description: "x".repeat(4 * 1024 * 1024) },
      ...catalog({ "exo-free": { limit: { context: 1_048_576, output: 131_072 } } }),
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));
    expect(parseCatalogFacts((await supplement(["exo-free"]))[0])?.contextTokens).toBe(1_048_576);
  });

  it("bounds oversized catalog responses and keeps ordinary fallback data", async () => {
    const payload = {
      irrelevantProvider: { description: "x".repeat(16 * 1024 * 1024) },
      ...catalog({ "exo-free": { limit: { context: 1_048_576 } } }),
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));
    expect(await supplement(["exo-free"])).toEqual(["exo-free"]);
  });

  it("coalesces concurrent requests and refreshes after thirty minutes", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = supplement(["exo-free"]);
    const second = supplement(["exo-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(jsonResponse(catalog({ "exo-free": { limit: { context: 1_048_576, output: 131_072 } } })));
    expect(await first).toEqual(await second);
    vi.mocked(Date.now).mockReturnValue(START + 29 * 60_000);
    await supplement(["exo-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(START + 30 * 60_000);
    fetchMock.mockImplementation(async () => jsonResponse(catalog({
      "exo-free": { limit: { context: 2_097_152, output: 262_144 } },
    })));
    expect(parseCatalogFacts((await supplement(["exo-free"]))[0])?.contextTokens).toBe(2_097_152);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps learned limits during outages and retries after one minute", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(catalog({
      "exo-free": { limit: { context: 1_048_576 } },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await supplement(["exo-free"]);
    vi.mocked(Date.now).mockReturnValue(START + 30 * 60_000);
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    expect(parseCatalogFacts((await supplement(["exo-free"]))[0])?.contextTokens).toBe(1_048_576);
    vi.mocked(Date.now).mockReturnValue(START + 31 * 60_000 - 1);
    await supplement(["exo-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(START + 31 * 60_000);
    fetchMock.mockResolvedValue(jsonResponse(catalog({ "exo-free": { limit: { context: 500_000 } } })));
    expect(parseCatalogFacts((await supplement(["exo-free"]))[0])?.contextTokens).toBe(500_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes newly discovered IDs early without repeatedly fetching unpublished limits", async () => {
    const addedId = `catalog-${randomUUID()}-free`;
    const fetchMock = vi.fn(async () => jsonResponse(catalog({
      "existing-free": { limit: { context: 262_144, output: 32_768 } },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await supplement(["existing-free"]);
    vi.mocked(Date.now).mockReturnValue(START + 60_000);
    fetchMock.mockImplementation(async () => jsonResponse(catalog({
      "existing-free": { limit: { context: 262_144, output: 32_768 } },
      [addedId]: { limit: { context: 1_572_864, output: 49_152 } },
    })));
    expect(parseCatalogFacts((await supplement([addedId]))[0])).toMatchObject({
      contextTokens: 1_572_864, maxOutputTokens: 49_152,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await supplement(["unpublished-free"]);
    vi.mocked(Date.now).mockReturnValue(START + 120_000 - 1);
    expect(await supplement(["unpublished-free"])).toEqual(["unpublished-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(START + 120_000);
    await supplement(["unpublished-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { kilo: { api: KILO_BASE_URL, models: { "exo-free": { limit: { context: 2_000_000 } } } } },
    { opencode: { api: `${ZEN_BASE_URL}/other`, models: { "exo-free": { limit: { context: 2_000_000 } } } } },
    catalog({ "exo-free": { id: "another-free", limit: { context: 2_000_000 } } }),
    catalog({ "exo-free": { limit: { context: 0, output: -1 } } }),
    catalog({ "exo-free": { limit: { context: "200000", output: null } } }),
  ])("ignores unrelated or invalid metadata: %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));
    expect(await supplement(["exo-free"])).toEqual(["exo-free"]);
  });

  it("uses ordinary fallback data when the supplemental endpoint fails", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await supplement(["unknown-free"])).toEqual(["unknown-free"]);
    await supplement(["unknown-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(START + 60_000);
    await supplement(["unknown-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Free model context discovery", () => {
  it("discovers newly added model limits after refresh without a model table entry", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clai-free-new-model-"));
    vi.stubEnv("CLAI_DATA_DIR", dataDir);
    const addedId = `catalog-${randomUUID()}-free`;
    let added = false;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === CATALOG_URL) return jsonResponse(catalog({
        "existing-free": { limit: { context: 262_144, output: 32_768 } },
        ...(added ? { [addedId]: { limit: { context: 1_572_864, output: 49_152 } } } : {}),
      }));
      if (url === `${ZEN_BASE_URL}/models`) return jsonResponse({ data: [
        { id: "existing-free" }, ...(added ? [{ id: addedId }] : []),
      ] });
      if (url === `${KILO_BASE_URL}/models`) return jsonResponse({ data: [
        { id: "existing-free", isFree: true, context_length: 256_000, max_completion_tokens: 32_000 },
        ...(added ? [{
          id: addedId, isFree: true,
          top_provider: { context_length: 300_000, max_completion_tokens: 27_648 },
        }] : []),
      ] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { freeProvider } = await import("../../src/llm/free.js");
    const { resolveContextWindow, modelMaxOutputTokens, nominalModelContextWindow } = await import("../../src/llm/context-windows.js");
    expect(nominalModelContextWindow(addedId)).toBe(200_000);
    await freeProvider.listModels!({});
    added = true;
    vi.mocked(Date.now).mockReturnValue(START + 30 * 60_000 - 1);
    expect(await freeProvider.listModels!({})).not.toContain(`free-1/${addedId}`);
    vi.mocked(Date.now).mockReturnValue(START + 30 * 60_000);
    const models = await freeProvider.listModels!({});
    expect(models).toContain(`free-1/${addedId}`);
    expect(models).toContain(`free-2/${addedId}`);
    expect(resolveContextWindow({ provider: "free", model: `free-1/${addedId}` })).toMatchObject({ tokens: 1_572_864, source: "provider" });
    expect(resolveContextWindow({ provider: "free", model: `free-2/${addedId}` })).toMatchObject({ tokens: 300_000, source: "provider" });
    expect(modelMaxOutputTokens("free", `free-1/${addedId}`)).toBe(49_152);
    expect(modelMaxOutputTokens("free", `free-2/${addedId}`)).toBe(27_648);
  });

  it.each(["complete", "stream"] as const)("uses source-specific output limits during %s", async (method) => {
    const bodies: Array<{ model: string; max_tokens: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === CATALOG_URL) return jsonResponse(catalog({
        "output-cap-free": { limit: { context: 1_048_576, output: 65_536 } },
      }));
      if (url === `${ZEN_BASE_URL}/models`) return jsonResponse({ data: [{ id: "output-cap-free" }] });
      if (url === `${KILO_BASE_URL}/models`) return jsonResponse({ data: [{
        id: "output-cap-free", isFree: true,
        top_provider: { context_length: 262_144, max_completion_tokens: 8_192 },
      }] });
      if (url.endsWith("/responses")) return new Response("not found", { status: 404 });
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return body.stream
          ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
              status: 200, headers: { "content-type": "text/event-stream" },
            })
          : jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { freeProvider } = await import("../../src/llm/free.js");
    await freeProvider.listModels!({});
    for (const source of ["free-1", "free-2"]) {
      const request = {
        model: `${source}/output-cap-free`,
        messages: [{ role: "user" as const, content: "hello" }],
        maxTokens: 100_000,
        thinking: { enabled: true, effort: "medium" as const },
      };
      if (method === "stream") await freeProvider.stream!(request, {}, () => {});
      else await freeProvider.complete(request, {});
    }
    expect(bodies.map((body) => body.max_tokens)).toEqual([65_536, 8_192]);
    expect(bodies.every((body) => body.model === "output-cap-free")).toBe(true);
  });

  it("retains distinct source limits and legacy Zen limits after restart", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clai-free-limits-"));
    vi.stubEnv("CLAI_DATA_DIR", dataDir);
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === CATALOG_URL) return jsonResponse(catalog({
        "shared-free": { limit: { context: 1_048_576, output: 131_072 } },
        "mimo-v2.6-flash-free": { limit: { context: 200_000, output: 32_000 } },
        "absent-free": { limit: { context: 4_000_000 } },
      }));
      if (url === `${ZEN_BASE_URL}/models`) return jsonResponse({ data: [
        { id: "shared-free" }, { id: "mimo-v2.6-flash-free" },
      ] });
      if (url === `${KILO_BASE_URL}/models`) return jsonResponse({ data: [
        {
          id: "shared-free", isFree: true, context_length: 1_310_720,
          top_provider: { context_length: 262_144, max_completion_tokens: 32_768 },
        },
      ] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { freeProvider } = await import("../../src/llm/free.js");
    const { modelContextWindow, modelMaxOutputTokens, resolveContextWindow } = await import("../../src/llm/context-windows.js");
    const { clearModelCatalogFacts } = await import("../../src/llm/capabilities.js");
    const { reloadRememberedModelLimits } = await import("../../src/llm/model-limit-store.js");
    const ids = await freeProvider.listModels!({ apiKey: "private-source-credential" });
    expect(ids).toEqual(["free-1/mimo-v2.6-flash-free", "free-1/shared-free", "free-2/shared-free"]);
    expect(modelContextWindow("free-1/shared-free", "free")).toBe(1_048_576);
    expect(modelContextWindow("free-2/shared-free", "free")).toBe(262_144);
    expect(modelMaxOutputTokens("free", "free-2/shared-free")).toBe(32_768);
    expect(modelContextWindow("mimo-v2.6-flash-free", "free")).toBe(200_000);
    const metadataRequest = fetchMock.mock.calls.find(([url]) => url === CATALOG_URL)!;
    expect(JSON.stringify(metadataRequest)).not.toContain("private-source-credential");
    clearModelCatalogFacts();
    reloadRememberedModelLimits();
    expect(modelContextWindow("free-1/shared-free", "free")).toBe(1_048_576);
    expect(modelContextWindow("free-2/shared-free", "free")).toBe(262_144);
    expect(modelContextWindow("shared-free", "free")).toBe(1_048_576);
    expect(modelMaxOutputTokens("free", "mimo-v2.6-flash-free")).toBe(32_000);
    expect(resolveContextWindow({ provider: "free", model: "unknown-free" })).toMatchObject({ tokens: 200_000, source: "default" });
  });
});
