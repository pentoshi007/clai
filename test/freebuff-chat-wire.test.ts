import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetFreebuffDeviceKeyState } from "../src/llm/freebuff-device-key.js";
import { fetchFreebuffModelIds, resetFreebuffCatalogCache } from "../src/llm/freebuff-models.js";
import { disposeFreebuffSessionManager } from "../src/llm/freebuff-session.js";
import { setFreebuffActingUserId } from "../src/llm/freebuff-wire.js";
import { freebuffProvider } from "../src/llm/freebuff.js";
import type { CompletionRequest } from "../src/types.js";

const TOKEN = "freebuff-chat-wire-token-0001";
const MODEL = "vendor/chat-model";
const FETCH_ID = "fetch-chat-1";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(): Response {
  const frames = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    "data: [DONE]",
  ];
  return new Response(frames.join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
}

function fixture(options: { failFirstRunOpen?: boolean; failFirstChat?: boolean } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  let runOpens = 0;
  let chatFailed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const raw = init?.headers;
      const headers: Record<string, string> = {};
      if (raw instanceof Headers) for (const [key, value] of raw.entries()) headers[key.toLowerCase()] = value;
      else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = String(value);
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        rawBody,
        body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      };
      calls.push(call);
      if (call.url.endsWith("/api/v1/freebuff/models")) {
        return json({
          protocol: 1,
          version: "catalog-chat",
          issuedAt: Date.now(),
          fetchId: FETCH_ID,
          rows: [{ key: MODEL, handle: MODEL, access: "open" }],
        });
      }
      if (call.url.endsWith("/api/v1/freebuff/device-keys")) return json({ keyId: "chat-device-key" });
      if (call.url.endsWith("/session/admission")) {
        return json({ status: "active", instanceId: "cli:wire", model: MODEL, remainingMs: 3_600_000 });
      }
      if (call.url.endsWith("/session/attempt")) return json({ status: "ended" });
      if (call.url.endsWith("/api/v1/agent-runs")) {
        if (call.body.action === "START") {
          runOpens += 1;
          if (options.failFirstRunOpen && runOpens === 1) return json({ error: "upstream busy" }, 503);
          return json({ runId: "run-chat" });
        }
        return json({ ok: true });
      }
      if (call.url.endsWith("/chat/completions")) {
        if (options.failFirstChat && !chatFailed) {
          chatFailed = true;
          return json(
            {
              error: "session_superseded",
              message:
                "This model purchase was refunded to the daily pool or wallet that paid for it. Start a new session to try again.",
            },
            409,
          );
        }
        if (call.body.stream) return sse();
        return json({
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      }
      return json({ status: "none" });
    }),
  );
  return { calls };
}

function request(): CompletionRequest {
  return { provider: "freebuff", model: MODEL, messages: [{ role: "user", content: "hello" }] };
}

function fromB64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

afterEach(async () => {
  await disposeFreebuffSessionManager();
  resetFreebuffDeviceKeyState();
  resetFreebuffCatalogCache();
  setFreebuffActingUserId(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Freebuff chat wire parity", () => {
  it("carries the CLI chat headers and signs the exact request body over the catalog fetch id", async () => {
    const { calls } = fixture();
    setFreebuffActingUserId("fixture-user");
    await fetchFreebuffModelIds(TOKEN);

    const result = await freebuffProvider.stream!(request(), { apiKey: TOKEN }, () => {});
    expect(result.text).toBe("ok");

    const registration = calls.find((call) => call.url.endsWith("/device-keys"))!;
    const publicKey = String(registration.body.publicKey);
    const chat = calls.find((call) => call.url.endsWith("/chat/completions"))!;

    expect(chat.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(chat.headers["user-agent"]).toBe(
      "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser",
    );
    expect(chat.headers.accept).toBe("*/*");
    expect(chat.headers["x-freebuff-sse-gzip-recovery"]).toBe("1");
    expect(chat.headers["x-freebuff-acting-user-id"]).toBe("fixture-user");
    expect(chat.headers["x-freebuff-catalog-fetch"]).toBe(FETCH_ID);
    expect(chat.headers["x-freebuff-device-key"]).toBe("chat-device-key");

    const canonical = [
      "freebuff-device-v1",
      "POST",
      "/api/v1/chat/completions",
      chat.headers["x-freebuff-device-ts"]!,
      createHash("sha256").update(chat.rawBody).digest("hex"),
      FETCH_ID,
    ].join("\n");
    const verified = await webcrypto.subtle.verify(
      { name: "Ed25519" },
      await webcrypto.subtle.importKey("raw", fromB64url(publicKey), { name: "Ed25519" }, false, ["verify"]),
      fromB64url(chat.headers["x-freebuff-device-sig"]!),
      new TextEncoder().encode(canonical),
    );
    expect(verified).toBe(true);

    const metadata = chat.body.codebuff_metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      freebuff_instance_id: "cli:wire",
      freebuff_multi_session: "1",
      surface: "cli",
      run_id: "run-chat",
      cost_mode: "free",
    });
    expect(String(metadata.freebuff_client_env)).toMatch(/^v1;/);
    expect(typeof metadata.client_id).toBe("string");
    expect(chat.body.provider).toEqual({ data_collection: "deny" });

    const wire = chat.body.messages as Array<Record<string, unknown>>;
    expect(wire[0]!.role).toBe("system");
    expect(String(wire[0]!.content)).toContain("You are Buffy, the coding agent behind Codebuff.");
    const parts = wire.at(-1)!.content as Array<Record<string, unknown>>;
    expect(parts.at(-1)?.cache_control).toEqual({ type: "ephemeral" });

    const run = calls.find((call) => call.url.endsWith("/api/v1/agent-runs") && call.body.action === "START")!;
    expect(run.body.agentId).toBe("base3-free-catalog");
  });

  it("drops a refunded session, surfaces the CLI retry hint and re-admits on the next request", async () => {
    const { calls } = fixture({ failFirstChat: true });
    await fetchFreebuffModelIds(TOKEN);
    const failed = freebuffProvider.complete!(request(), { apiKey: TOKEN });
    await expect(failed).rejects.toThrow(/refunded/i);
    await expect(failed).rejects.toThrow(/send your message again to retry/);
    await expect(freebuffProvider.complete!(request(), { apiKey: TOKEN })).resolves.toMatchObject({ text: "ok" });
    expect(calls.filter((call) => call.url.endsWith("/session/admission"))).toHaveLength(2);
  });

  it("retries the agent-run open once on a transient 5xx and tags runs with the acting user", async () => {
    const { calls } = fixture({ failFirstRunOpen: true });
    setFreebuffActingUserId("retry-user");
    const result = await freebuffProvider.complete!(request(), { apiKey: TOKEN });
    expect(result.text).toBe("ok");
    expect(result.usage?.promptTokens).toBe(3);
    const opens = calls.filter((call) => call.url.endsWith("/api/v1/agent-runs") && call.body.action === "START");
    expect(opens).toHaveLength(2);
    expect(opens.every((call) => call.headers["x-freebuff-acting-user-id"] === "retry-user")).toBe(true);
    expect(opens[1]!.body.agentId).toBe("base2-free");
  });
});
