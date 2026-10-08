import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuth } from "../src/llm/provider.js";

const h = vi.hoisted(() => ({ prepare: vi.fn(), free: vi.fn() }));
vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({ prepare: h.prepare, free: h.free }),
  },
}));

const auth: ProviderAuth = {
  apiKey: JSON.stringify({
    uid: "fixture-user", accessToken: "fixture-access", expireTime: 4_000_000_000,
    encryptUserInfo: "fixture-user-info", key: "fixture-key", machineId: "fixture-machine",
    machineCode: "fixture-code", machineToken: "fixture-token",
  }),
};
const catalog = {
  chat: [
    { key: "qfmodel", is_free: true },
    { key: "zero-price", price_factor: 0 },
    { key: "paid", price_factor: 0.5 },
  ],
};
const catalogLimit = 4 * 1024 * 1024;

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

async function listModels(): Promise<string[]> {
  const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
  return qoderProvider.listModels!({ ...auth });
}

beforeEach(() => {
  vi.resetModules();
  h.free.mockReset();
  h.prepare.mockReset().mockReturnValue({
    url: "https://test.invalid/model/list?Encode=1",
    headers: { "Accept-Encoding": "identity", "Authorization": "fixture-access" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Qoder model catalogs", () => {
  it.each(["leading", "trailing"])("reads a catalog larger than 64 KiB with %s metadata", async (position) => {
    const padding = "x".repeat(70_000);
    const payload = position === "leading" ? { inline: padding, ...catalog } : { ...catalog, inline: padding };
    const response = json(payload);
    expect(Buffer.byteLength(await response.clone().text())).toBeGreaterThan(65_536);
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(listModels()).resolves.toEqual(["paid:0.5x", "qfmodel:free", "zero-price:free"]);
    expect(h.free).toHaveBeenCalledOnce();
  });

  it("decodes fragmented multibyte JSON larger than the error-body limit", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ padding: "中".repeat(30_000), chat: [{ key: "model-中", price_factor: 0 }] }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1021) controller.enqueue(bytes.slice(offset, offset + 1021));
        controller.close();
      },
    }))));
    await expect(listModels()).resolves.toEqual(["model-中:free"]);
  });

  it("accepts a complete catalog exactly at the catalog-body limit", async () => {
    const base = JSON.stringify({ padding: "", ...catalog });
    const raw = JSON.stringify({ padding: "x".repeat(catalogLimit - Buffer.byteLength(base)), ...catalog });
    expect(Buffer.byteLength(raw)).toBe(catalogLimit);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    await expect(listModels()).resolves.toContain("qfmodel:free");
  });

  it("rejects oversized catalogs explicitly and cancels the unread body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(catalogLimit + 1).fill(32)); },
      cancel,
    }))));
    await expect(listModels()).rejects.toMatchObject({ name: "ProviderError", status: 502, message: expect.stringMatching(/model catalog.*4 MiB/) });
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.free).toHaveBeenCalledOnce();
  });

  it.each(["{\"chat\": [", "<html>unavailable</html>", ""])("reports malformed catalog JSON instead of a raw parse error: %s", async (raw) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    await expect(listModels()).rejects.toMatchObject({ name: "ProviderError", status: 502, message: expect.stringMatching(/malformed model catalog/) });
    expect(h.free).toHaveBeenCalledOnce();
  });

  it.each(["null", "[]", "42", "{}", "{\"chat\":{}}"])("rejects an invalid catalog shape: %s", async (raw) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw)));
    await expect(listModels()).rejects.toMatchObject({ name: "ProviderError", status: 502, message: expect.stringMatching(/invalid model catalog/) });
  });

  it("skips invalid model entries and tolerates malformed optional metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ chat: [null, {}, { key: 7 }, { key: " " }, { key: "qfmodel", price_factor: 0, thinking_config: "invalid", display_name: 5 }] })));
    await expect(listModels()).resolves.toEqual(["qfmodel:free"]);
  });

  it.each([401, 403])("preserves genuine HTTP %s authentication failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"invalid token"}', { status })));
    await expect(listModels()).rejects.toMatchObject({ name: "ProviderError", status, message: expect.stringContaining("invalid token") });
    expect(h.free).toHaveBeenCalledOnce();
  });

  it("keeps the smaller cap for error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(100_000), { status: 403 })));
    await expect(listModels()).rejects.toMatchObject({ status: 403, body: "x".repeat(65_536) });
  });

  it("signs the existing catalog endpoint and preserves transport headers", async () => {
    const fetcher = vi.fn(async (_input: unknown, _init?: RequestInit) => json(catalog));
    vi.stubGlobal("fetch", fetcher);
    await listModels();
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ path: "/api/v2/model/list?Encode=1", method: "GET", authType: "auth" }));
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Cosy-MachineToken")).toBe("fixture-token");
    expect(headers.get("Authorization")).toBe("fixture-access");
    expect(headers.get("Accept-Encoding")).toBeNull();
  });

  it("caches successful model lists but never caches a failed read", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => new Response('{"chat":'))
      .mockImplementation(async () => json(catalog));
    vi.stubGlobal("fetch", fetcher);
    await expect(listModels()).rejects.toThrow();
    const models = await listModels();
    await expect(listModels()).resolves.toEqual(models);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the same complete catalog reader for authentication ping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...catalog, padding: "x".repeat(70_000) })));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    await expect(qoderProvider.ping!({ ...auth })).resolves.toBeUndefined();
    expect(h.free).toHaveBeenCalledOnce();
  });

  it("times out and cancels a stalled catalog body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Catalog request timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const promise = qoderProvider.listModels!({ ...auth });
    const check = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(20_001);
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.free).toHaveBeenCalledOnce();
  });
});
