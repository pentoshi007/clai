import { describe, expect, it, vi } from "vitest";

import { ProviderError } from "../src/llm/http.js";
import {
  callFreebuffSession,
  FreebuffSessionRequestError,
  newFreebuffCliInstanceId,
} from "../src/llm/freebuff-session-api.js";
import {
  FreebuffSessionManager,
  freebuffSessionManager,
  runFreebuffSessionShutdownCleanup,
} from "../src/llm/freebuff-session.js";
import { RendererLifecycle } from "../src/ui-core/bootstrap/lifecycle.js";

const TOKEN = "freebuff-opaque-token-abcdef123456";
const BASE = "https://www.codebuff.com";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stubFetch(
  respond: (url: string, method: string) => Response,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (raw instanceof Headers) {
        for (const [k, v] of raw.entries()) headers[k.toLowerCase()] = v;
      } else if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers });
      return respond(url, method);
    }),
  );
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Freebuff session protocol", () => {
  it("sends the CLI multi-session admission headers with a zero wallet limit", async () => {
    const calls = stubFetch(() =>
      json(200, { status: "active", instanceId: "cli:abc", model: "deepseek/deepseek-v4-flash" }),
    );
    await callFreebuffSession("POST", TOKEN, {
      instanceId: "cli:abc",
      model: "deepseek/deepseek-v4-flash",
      baseUrl: BASE,
    });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/api/v1/freebuff/session/admission`);
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["x-freebuff-multi-session"]).toBe("1");
    expect(call.headers["x-freebuff-purchase-continuity"]).toBe("1");
    expect(call.headers["x-freebuff-desktop-attempt-id"]).toBe("abc");
    expect(call.headers["x-freebuff-instance-id"]).toBe("cli:abc");
    expect(call.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(call.headers["x-freebuff-wallet-spend-limit"]).toBe("0");
  });

  it("marks heartbeat GETs and never beats the admission route", async () => {
    const calls = stubFetch(() => json(200, { status: "active", instanceId: "cli:abc", model: "m" }));
    await callFreebuffSession("GET", TOKEN, {
      instanceId: "cli:abc",
      heartbeat: true,
      baseUrl: BASE,
    });
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/api/v1/freebuff/session`);
    expect(call.headers["x-freebuff-heartbeat"]).toBe("1");
    expect(call.headers["x-freebuff-include-unused-rate-limits"]).toBe("1");
    expect(call.headers["x-freebuff-instance-id"]).toBe("cli:abc");
  });

  it("releases CLI claims through the attempt route", async () => {
    const calls = stubFetch(() => json(200, { status: "ended" }));
    await callFreebuffSession("DELETE", TOKEN, {
      instanceId: "cli:claim-1",
      baseUrl: BASE,
    });
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/freebuff/session/attempt`);
  });

  it("surfaces typed refusals and read-only absence instead of throwing", async () => {
    stubFetch(() => json(409, { status: "model_locked", currentModel: "a", requestedModel: "b" }));
    expect(await callFreebuffSession("POST", TOKEN, { instanceId: "cli:x", baseUrl: BASE })).toMatchObject({
      status: "model_locked",
    });

    stubFetch(() => json(404, {}));
    expect(await callFreebuffSession("GET", TOKEN, { baseUrl: BASE })).toEqual({ status: "none" });

    stubFetch(() => json(404, {}));
    await expect(
      callFreebuffSession("POST", TOKEN, { instanceId: "cli:x", baseUrl: BASE }),
    ).rejects.toBeInstanceOf(FreebuffSessionRequestError);

    stubFetch(() => json(429, { status: "spend_limited", message: "budget" }));
    expect(await callFreebuffSession("POST", TOKEN, { instanceId: "cli:x", baseUrl: BASE })).toMatchObject({
      status: "spend_limited",
    });

    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(callFreebuffSession("GET", TOKEN, { baseUrl: BASE })).rejects.toBeInstanceOf(
      FreebuffSessionRequestError,
    );
  });

  it("mints CLI-prefixed single-use identities", () => {
    expect(newFreebuffCliInstanceId()).toMatch(/^cli:[0-9a-f-]{36}$/);
  });
});

describe("FreebuffSessionManager", () => {
  it("admits once, coalesces concurrent callers, and reuses the live claim", async () => {
    let admissions = 0;
    stubFetch((url, method) => {
      if (method === "POST") {
        admissions += 1;
        return json(200, {
          status: "active",
          instanceId: "cli:live",
          model: "deepseek/deepseek-v4-flash",
          remainingMs: 3_600_000,
        });
      }
      return json(200, { status: "active", instanceId: "cli:live", model: "m" });
    });
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    const [a, b] = await Promise.all([
      manager.ensureAdmission(TOKEN, "deepseek/deepseek-v4-flash"),
      manager.ensureAdmission(TOKEN, "deepseek/deepseek-v4-flash"),
    ]);
    expect(admissions).toBe(1);
    expect(a.instanceId).toBe("cli:live");
    expect(b.metadata).toEqual({
      freebuff_instance_id: "cli:live",
      freebuff_multi_session: "1",
      surface: "cli",
    });
    await manager.ensureAdmission(TOKEN, "deepseek/deepseek-v4-flash");
    expect(admissions).toBe(1);
    await manager.dispose();
  });

  it("scopes claims per token so one account never reuses another's instance", async () => {
    let admissions = 0;
    stubFetch(() => {
      admissions += 1;
      return json(200, {
        status: "active",
        instanceId: `cli:${admissions}`,
        model: "deepseek/deepseek-v4-flash",
      });
    });
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    const first = await manager.ensureAdmission(TOKEN, "deepseek/deepseek-v4-flash");
    const second = await manager.ensureAdmission("a-different-token-9876543210", "deepseek/deepseek-v4-flash");
    expect(admissions).toBe(2);
    expect(first.instanceId).not.toBe(second.instanceId);
    await manager.dispose();
  });

  it("refuses wallet-spending admission with an actionable typed error", async () => {
    stubFetch(() =>
      json(409, {
        status: "consent_required",
        walletConsent: { price: 120, walletSpend: 120 },
      }),
    );
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    await expect(manager.ensureAdmission(TOKEN, "m")).rejects.toThrow(/wallet Freebucks/);
    await expect(manager.ensureAdmission(TOKEN, "m")).rejects.toBeInstanceOf(ProviderError);
    await manager.dispose();
  });

  it("maps quota refusals to their HTTP status", async () => {
    stubFetch(() => json(429, { status: "rate_limited", model: "m" }));
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    const error = await manager.ensureAdmission(TOKEN, "m").catch((e: ProviderError) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(429);
    await manager.dispose();
  });

  it("releases its generated attempt id when admission response is lost", async () => {
    const calls = stubFetch((_url, method) => {
      if (method === "POST") throw new Error("response lost after commit");
      return json(200, { status: "ended" });
    });
    const manager = new FreebuffSessionManager({ baseUrl: BASE });

    await expect(manager.ensureAdmission(TOKEN, "m")).rejects.toThrow("response lost after commit");

    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(calls[0]!.headers["x-freebuff-desktop-attempt-id"]).toBeTruthy();
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/freebuff/session/attempt`);
    expect(calls[1]!.headers["x-freebuff-desktop-attempt-id"]).toBe(
      calls[0]!.headers["x-freebuff-desktop-attempt-id"],
    );
    await manager.dispose();
  });

  it("releases owned claims on explicit lifecycle cleanup", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    stubFetch((url, method) => {
      calls.push({ method, url });
      if (method === "POST") {
        return json(200, { status: "active", instanceId: "cli:owned", model: "m" });
      }
      return json(200, { status: "ended" });
    });
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    await manager.ensureAdmission(TOKEN, "m");
    await manager.dispose();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(manager.hasActiveClaim(TOKEN, "m")).toBe(false);
  });

  it("releases the previous claim before re-admitting and on explicit release", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let admissions = 0;
    stubFetch((url, method) => {
      calls.push({ method, url });
      if (method === "POST") {
        admissions += 1;
        return json(200, { status: "active", instanceId: `cli:${admissions}`, model: "m" });
      }
      return json(200, { status: "ended" });
    });
    const manager = new FreebuffSessionManager({ baseUrl: BASE });
    await manager.ensureAdmission(TOKEN, "m");
    await manager.release(TOKEN, "m");
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(`${BASE}/api/v1/freebuff/session/attempt`);
    expect(manager.hasActiveClaim(TOKEN, "m")).toBe(false);
    await manager.dispose();
  });

  it("releases owned claims after renderer destruction during shutdown", async () => {
    const events: string[] = [];
    const calls = stubFetch((url, method) => {
      if (method === "POST") {
        return json(200, {
          status: "active",
          instanceId: "cli:shutdown",
          model: "shutdown-model",
          remainingMs: 3_600_000,
        });
      }
      if (method === "DELETE") events.push("release");
      return json(200, { status: method === "DELETE" ? "ended" : "none" });
    });
    await freebuffSessionManager().ensureAdmission(TOKEN, "shutdown-model");
    const lifecycle = new RendererLifecycle({
      handle: {
        start: () => undefined,
        destroy: () => {
          events.push("destroy");
        },
      },
      process: {
        on: () => undefined,
        off: () => undefined,
        exit: () => undefined,
      },
      epilogue: () =>
        runFreebuffSessionShutdownCleanup(async () => {
          events.push("epilogue");
        }),
    });

    await lifecycle.start();
    await lifecycle.shutdown();

    expect(events).toEqual(["destroy", "release", "epilogue"]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/freebuff/session/attempt`);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});
