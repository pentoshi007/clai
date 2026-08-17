import { describe, expect, it } from "vitest";
import { ProviderError, readJson } from "../src/llm/http.js";

// summarizeProviderError is not exported; exercise via thrown stream/complete
// paths would need network. Mirror the classification rules here by importing
// router internals through a thin re-export if available — otherwise test the
// public error surface that users see after failures.

// Prefer testing the exported helper if we add one; for now export a test seam.
import { formatProviderFailureForUser, isEmptyCompletionError } from "../src/llm/router.js";

describe("provider failure messaging", () => {
  it("maps auth errors to actionable key guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("unauthorized", 401),
    );
    expect(msg).toMatch(/API key|providers/i);
    expect(msg).toContain("401");
  });

  it("maps 413 to compact guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("too large", 413),
    );
    expect(msg).toMatch(/compact|input limit/i);
  });

  it("maps disconnects to free-tier / long-context guidance", () => {
    const msg = formatProviderFailureForUser(
      new Error("socket connection was closed unexpectedly"),
    );
    expect(msg).toMatch(/connection dropped|disconnect/i);
  });

  it("maps empty message to admission failure guidance", () => {
    const msg = formatProviderFailureForUser(new Error(""));
    expect(msg).toMatch(/unavailable|overloaded|admission/i);
  });

  it("maps 503 capacity language", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("bad gateway", 503),
    );
    expect(msg).toMatch(/unavailable|capacity|free-tier/i);
  });

  it("maps cache_only_cold 503 admissions to cache-admission guidance", () => {
    const body =
      '{"error":{"message":"cache-only admission rejected a cold or overloaded request","type":"ServiceUnavailable","param":"","code":"cache_only_cold"},"id":45648,"org_id":"","role":1}';
    const msg = formatProviderFailureForUser(
      new ProviderError(
        "cache-only admission rejected a cold or overloaded request",
        503,
        body,
      ),
    );
    expect(msg).toContain("cache admission rejected (503; cache_only_cold)");
    expect(msg).toMatch(/backoff/i);
    expect(msg).toContain("cache-only admission rejected a cold or overloaded request");
  });

  it("preserves the exact provider error alongside rate-limit guidance", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError("Gemini quota exceeded; retry in 31 seconds", 429),
    );
    expect(msg).toContain("Model is rate limited (429)");
    expect(msg).toContain("Exact provider error: Gemini quota exceeded; retry in 31 seconds");
  });
});

describe("isEmptyCompletionError", () => {
  it("detects a provider that completed without a visible answer", () => {
    expect(
      isEmptyCompletionError(
        new ProviderError("bynara completed without a visible answer."),
      ),
    ).toBe(true);
  });

  it("detects the router-wrapped empty completion failure", () => {
    expect(
      isEmptyCompletionError(
        new Error(
          "No provider could stream the request. — bynara: bynara completed without a visible answer.",
        ),
      ),
    ).toBe(true);
  });

  it("does not treat auth, rate-limit, or generic failures as empty completions", () => {
    expect(isEmptyCompletionError(new ProviderError("unauthorized", 401))).toBe(false);
    expect(isEmptyCompletionError(new ProviderError("too large", 413))).toBe(false);
    expect(isEmptyCompletionError(new Error("socket connection was closed"))).toBe(false);
  });
});

describe("full provider error visibility (regression: truncated provider errors)", () => {
  it("readJson surfaces the complete JSON error body when it adds information", async () => {
    const body = JSON.stringify({
      error: {
        message: "upstream provider failed",
        code: "channel_exhausted",
        details: { upstream: "qwen", hint: "retry with a smaller prompt" },
      },
    });
    const error = await readJson(
      new Response(body, { status: 400 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    const message = (error as ProviderError).message;
    expect(message).toContain("Provider request failed with HTTP 400");
    expect(message).toContain("upstream provider failed");
    // The fields beyond error.message must be visible to the user.
    expect(message).toContain("full response:");
    expect(message).toContain("channel_exhausted");
    expect(message).toContain("retry with a smaller prompt");
    // The retained body is no longer clipped to 1KB.
    expect((error as ProviderError).body).toBe(body);
  });

  it("readJson keeps a bare error envelope compact (no redundant dump)", async () => {
    const error = await readJson(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
      }),
    ).catch((e: unknown) => e);
    const message = (error as ProviderError).message;
    expect(message).toContain("invalid api key");
    expect(message).not.toContain("full response:");
  });

  it("readJson shows a non-JSON error body in full (was capped at 200 chars)", async () => {
    const html = `<html><body><h1>502 Bad Gateway</h1><p>${"x".repeat(400)}</p></body></html>`;
    const error = await readJson(
      new Response(html, { status: 502 }),
    ).catch((e: unknown) => e);
    const message = (error as ProviderError).message;
    expect(message).toContain("full response:");
    expect(message).toContain("502 Bad Gateway");
    // The whole body survived — not just the legacy 200-char prefix.
    expect(message).toContain("x".repeat(400));
  });

  it("formatProviderFailureForUser appends a body that the message omits", () => {
    const msg = formatProviderFailureForUser(
      new ProviderError(
        "TokenRouter stream error: unknown error",
        undefined,
        '{"error":{"message":"unknown error","upstream":"qwen gateway overloaded"}}',
      ),
    );
    expect(msg).toContain("Full response from provider:");
    expect(msg).toContain("qwen gateway overloaded");
  });

  it("formatProviderFailureForUser does not duplicate a body already in the message", () => {
    const body = '{"error":{"message":"Provider request failed with HTTP 429"}}';
    const msg = formatProviderFailureForUser(
      new ProviderError(
        `Provider request failed with HTTP 429 — full response: ${body}`,
        429,
        body,
      ),
    );
    expect(msg).not.toContain("Full response from provider:");
  });
});
