import { afterEach, describe, expect, it, vi } from "vitest";

import { resetFreebuffDeviceKeyState } from "../src/llm/freebuff-device-key.js";
import {
  fetchFreebuffModelIds,
  freebuffCatalogHandle,
  freebuffCatalogSnapshot,
  resetFreebuffCatalogCache,
} from "../src/llm/freebuff-models.js";
import {
  disposeFreebuffSessionManager,
  FreebuffSessionManager,
} from "../src/llm/freebuff-session.js";

const BASE = "https://www.codebuff.com";
const TOKEN = "freebuff-catalog-device-token-0001";
const STALE_TOKEN = "freebuff-catalog-device-token-0002";
const MODEL_KEY = "vendor/catalog-model";
const MODEL_HANDLE = "vendor/catalog-handle";
const FETCH_ID = "fetch-cat-1";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixture(options: { staleAdmissions?: number } = {}): { calls: Call[]; admissions: () => number } {
  const calls: Call[] = [];
  let remainingStale = options.staleAdmissions ?? 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const raw = init?.headers;
      const headers: Record<string, string> = {};
      if (raw instanceof Headers) for (const [key, value] of raw.entries()) headers[key.toLowerCase()] = value;
      else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = String(value);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      if (call.url.endsWith("/api/v1/freebuff/models")) {
        return json({
          protocol: 1,
          version: "catalog-1",
          issuedAt: Date.now(),
          fetchId: FETCH_ID,
          rows: [{ key: MODEL_KEY, handle: MODEL_HANDLE, access: "open" }],
        });
      }
      if (call.url.endsWith("/api/v1/freebuff/device-keys")) {
        return json({ keyId: "catalog-device-key" });
      }
      if (call.url.endsWith("/session/admission")) {
        if (remainingStale > 0) {
          remainingStale -= 1;
          return json({ error: "freebuff_catalog_stale" }, 409);
        }
        return json({ status: "active", instanceId: "cli:catalog", model: MODEL_KEY, remainingMs: 3_600_000 });
      }
      if (call.url.endsWith("/session/attempt")) return json({ status: "ended" });
      return json({ status: "none" });
    }),
  );
  return {
    calls,
    admissions: () => calls.filter((call) => call.url.endsWith("/session/admission")).length,
  };
}

afterEach(async () => {
  await disposeFreebuffSessionManager();
  resetFreebuffDeviceKeyState();
  resetFreebuffCatalogCache();
  vi.unstubAllGlobals();
});

describe("Freebuff catalog protocol", () => {
  it("requests the CLI catalog with protocol headers and stores the fetch id and handles", async () => {
    const { calls } = fixture();
    const ids = await fetchFreebuffModelIds(TOKEN);
    expect(ids).toContain(MODEL_KEY);
    const catalog = calls.find((call) => call.url.endsWith("/api/v1/freebuff/models"))!;
    expect(catalog.method).toBe("GET");
    expect(catalog.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(catalog.headers["x-freebuff-catalog-protocol"]).toBe("1");
    expect(catalog.headers["x-freebuff-client"]).toBe("cli");
    expect(catalog.headers["x-freebuff-catalog-fetch"]).toBeUndefined();
    expect(catalog.headers["x-freebuff-device-key"]).toBeUndefined();
    expect(freebuffCatalogSnapshot(TOKEN)?.fetchId).toBe(FETCH_ID);
    expect(freebuffCatalogHandle(TOKEN, MODEL_KEY)).toBe(MODEL_HANDLE);
  });

  it("signs admission with the catalog fetch id, registered device key and catalog handle", async () => {
    const { calls } = fixture();
    await fetchFreebuffModelIds(TOKEN);
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    await manager.ensureAdmission(TOKEN, MODEL_KEY);

    const registration = calls.find((call) => call.url.endsWith("/api/v1/freebuff/device-keys"))!;
    expect(registration.method).toBe("POST");
    expect(registration.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(registration.body.client).toBe("cli");
    expect(typeof registration.body.publicKey).toBe("string");

    const admission = calls.find((call) => call.url.endsWith("/session/admission"))!;
    expect(admission.headers["x-freebuff-model"]).toBe(MODEL_HANDLE);
    expect(admission.headers["x-freebuff-wallet-spend-limit"]).toBe("session");
    expect(admission.headers["x-freebuff-catalog-protocol"]).toBe("1");
    expect(admission.headers["x-freebuff-catalog-fetch"]).toBe(FETCH_ID);
    expect(admission.headers["x-freebuff-device-key"]).toBe("catalog-device-key");
    expect(Number(admission.headers["x-freebuff-device-ts"])).toBeGreaterThan(0);
    expect(admission.headers["x-freebuff-device-sig"]).toBeTruthy();
  });

  it("refreshes the catalog once and retries admission after a stale catalog error", async () => {
    const { calls, admissions } = fixture({ staleAdmissions: 1 });
    await fetchFreebuffModelIds(STALE_TOKEN);
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    const admission = await manager.ensureAdmission(STALE_TOKEN, MODEL_KEY);
    expect(admission.instanceId).toBe("cli:catalog");
    expect(admissions()).toBe(2);
    expect(calls.filter((call) => call.url.endsWith("/api/v1/freebuff/models"))).toHaveLength(2);
    const refresh = calls.filter((call) => call.url.endsWith("/api/v1/freebuff/models"))[1]!;
    expect(refresh.headers["x-freebuff-device-key"]).toBe("catalog-device-key");
  });
});
