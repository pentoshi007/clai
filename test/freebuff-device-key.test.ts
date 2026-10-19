import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FREEBUFF_DEVICE_KEY_HEADER,
  FREEBUFF_DEVICE_SIG_HEADER,
  FREEBUFF_DEVICE_TS_HEADER,
  freebuffDeviceHeaders,
  resetFreebuffDeviceKeyState,
  setFreebuffDeviceKeyDeps,
} from "../src/llm/freebuff-device-key.js";

const TOKEN = "freebuff-device-token-abcdef123456";
const NOW = 1_760_000_000_000;
const ADMISSION_URL = "https://www.codebuff.com/api/v1/freebuff/session/admission";
const MODELS_URL = "https://www.codebuff.com/api/v1/freebuff/models";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const dirs: string[] = [];
let clock = NOW;

function setup(respond?: (call: Call) => Response | Promise<Response>): { calls: Call[]; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "clai-freebuff-device-"));
  dirs.push(dir);
  const path = join(dir, "device-key.json");
  const calls: Call[] = [];
  setFreebuffDeviceKeyDeps({
    now: () => clock,
    storePath: path,
    fetch: vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw instanceof Headers) for (const [k, v] of raw.entries()) headers[k.toLowerCase()] = v;
      else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      return respond?.(call) ?? new Response(JSON.stringify({ keyId: "device-key-1" }), { status: 200 });
    }),
  });
  return { calls, path };
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function verify(canonical: string, publicKey: string, signature: string): Promise<boolean> {
  return webcrypto.subtle.verify(
    { name: "Ed25519" },
    await webcrypto.subtle.importKey("raw", fromB64url(publicKey), { name: "Ed25519" }, false, ["verify"]),
    fromB64url(signature),
    new TextEncoder().encode(canonical),
  );
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

afterEach(() => {
  resetFreebuffDeviceKeyState();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  clock = NOW;
  vi.restoreAllMocks();
});

describe("Freebuff device key", () => {
  it("generates an Ed25519 key, registers it and signs the request canonically", async () => {
    const { calls, path } = setup();
    const headers = await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: "{}" });

    expect(Object.keys(headers).sort()).toEqual(
      [FREEBUFF_DEVICE_KEY_HEADER, FREEBUFF_DEVICE_SIG_HEADER, FREEBUFF_DEVICE_TS_HEADER].sort(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://www.codebuff.com/api/v1/freebuff/device-keys");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.body.client).toBe("cli");

    const publicKey = String(calls[0]!.body.publicKey);
    expect(fromB64url(publicKey)).toHaveLength(32);
    expect(headers[FREEBUFF_DEVICE_KEY_HEADER]).toBe("device-key-1");
    expect(headers[FREEBUFF_DEVICE_TS_HEADER]).toBe(String(NOW));

    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ version: 1, publicKey });
    expect(Object.keys(record.registrations as object)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const canonical = ["freebuff-device-v1", "POST", "/api/v1/freebuff/session/admission", String(NOW), sha256Hex("{}"), ""].join("\n");
    await expect(verify(canonical, publicKey, headers[FREEBUFF_DEVICE_SIG_HEADER]!)).resolves.toBe(true);
  });

  it("reuses the stored key and registration across origins without re-registering", async () => {
    const { calls } = setup();
    await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null });
    await freebuffDeviceHeaders({ token: TOKEN, method: "GET", url: "https://www.codebuff.com/api/v1/freebuff/session" });
    await freebuffDeviceHeaders({ token: TOKEN, method: "GET", url: MODELS_URL });
    clock += 5_000;
    await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null });
    expect(calls.filter((call) => call.url.endsWith("/device-keys"))).toHaveLength(1);
  });

  it("skips key creation entirely when register is false and nothing is stored", async () => {
    const { calls } = setup();
    const headers = await freebuffDeviceHeaders({ token: TOKEN, method: "GET", url: MODELS_URL, register: false });
    expect(headers).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("degrades to empty headers on network failure and honors the retry window", async () => {
    let attempts = 0;
    setup(() => {
      attempts += 1;
      throw new Error("offline");
    });
    expect(await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null })).toEqual({});
    clock += 299_000;
    expect(await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null })).toEqual({});
    expect(attempts).toBe(1);
    clock += 2_000;
    expect(await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null })).toEqual({});
    expect(attempts).toBe(2);
  });

  it("waits an hour after an unsupported server and reports empty headers on a missing keyId", async () => {
    let attempts = 0;
    setup(() => {
      attempts += 1;
      return new Response("", { status: 405 });
    });
    expect(await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null })).toEqual({});
    clock += 299_000;
    await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null });
    expect(attempts).toBe(1);
    clock += 3_601_000;
    await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null });
    expect(attempts).toBe(2);
  });

  it("never throws when the registration answer has no keyId", async () => {
    setup(() => new Response(JSON.stringify({}), { status: 200 }));
    expect(await freebuffDeviceHeaders({ token: TOKEN, method: "POST", url: ADMISSION_URL, body: null })).toEqual({});
  });

  it("binds the signature to the catalog fetchId", async () => {
    const { calls } = setup(() => new Response(JSON.stringify({ keyId: "key-2" }), { status: 200 }));
    const headers = await freebuffDeviceHeaders({ token: TOKEN, method: "GET", url: MODELS_URL, fetchId: "fetch-9" });
    const publicKey = String(calls[0]!.body.publicKey);
    const canonical = ["freebuff-device-v1", "GET", "/api/v1/freebuff/models", String(NOW), sha256Hex(""), "fetch-9"].join("\n");
    await expect(verify(canonical, publicKey, headers[FREEBUFF_DEVICE_SIG_HEADER]!)).resolves.toBe(true);
    const wrong = ["freebuff-device-v1", "GET", "/api/v1/freebuff/models", String(NOW), sha256Hex(""), ""].join("\n");
    await expect(verify(wrong, publicKey, headers[FREEBUFF_DEVICE_SIG_HEADER]!)).resolves.toBe(false);
  });
});
