import { afterEach, describe, expect, it } from "vitest";
import { generationFetch } from "../../src/llm/operation-usage.js";
import { sessionCacheAffinityKey } from "../../src/llm/cache-affinity.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";

const realFetch = globalThis.fetch;
let captured: RequestInit[] = [];

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? undefined);
}

function installCapture(): void {
  captured = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    captured.push(init ?? {});
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("session affinity headers", () => {
  it("stamps every provider request with stable per-session headers", async () => {
    installCapture();
    await withSessionAffinity("ses_abc123", () =>
      generationFetch("https://gateway.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(headersOf(captured[0]).get("x-clai-session")).toBe("ses_abc123");
    expect(headersOf(captured[0]).get("x-session-affinity")).toMatch(
      /^clai-[a-f0-9]{40}$/,
    );
  });

  it("derives the affinity value from the session id, not the message bytes", () => {
    expect(sessionCacheAffinityKey("ses_one")).not.toBe(
      sessionCacheAffinityKey("ses_two"),
    );
  });

  it("sends no session headers outside a session context", async () => {
    installCapture();
    await generationFetch("https://gateway.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(headersOf(captured[0]).has("x-clai-session")).toBe(false);
    expect(headersOf(captured[0]).has("x-session-affinity")).toBe(false);
  });

  it("leaves caller-provided session headers untouched", async () => {
    installCapture();
    await withSessionAffinity("ses_abc", () =>
      generationFetch("https://gateway.test/v1/messages", {
        method: "POST",
        headers: { "x-clai-session": "ses_custom" },
      }),
    );
    expect(headersOf(captured[0]).get("x-clai-session")).toBe("ses_custom");
  });
});
