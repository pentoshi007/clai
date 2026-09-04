import { describe, expect, it } from "vitest";
import { ProviderError, readJson } from "../../src/llm/http.js";
import { parseResetSeconds } from "../../src/llm/wire/response-errors.js";

async function rejectionFor(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ProviderError> {
  const response = new Response(JSON.stringify(body), {
    status: 429,
    headers: { "content-type": "application/json", ...headers },
  });
  try {
    await readJson(response);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected readJson to reject");
}

describe("provider reset metadata extraction", () => {
  it("prefers the Retry-After header", async () => {
    const error = await rejectionFor({}, {
      "retry-after": "12",
      "x-ratelimit-reset": String(Date.now() + 90_000),
    });
    expect(error.retryAfterSeconds).toBe(12);
  });

  it("reads relative seconds from reset headers", async () => {
    const error = await rejectionFor({}, { "x-ratelimit-reset": "90" });
    expect(error.retryAfterSeconds).toBe(90);
  });

  it("converts epoch-second reset headers into seconds from now", async () => {
    const error = await rejectionFor(
      {},
      { "ratelimit-reset": String(Math.floor(Date.now() / 1000) + 40) },
    );
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(35);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(45);
  });

  it("converts epoch-millisecond reset headers into seconds from now", async () => {
    const error = await rejectionFor(
      {},
      { "x-ratelimit-reset": String(Date.now() + 25_000) },
    );
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(20);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("converts HTTP-date reset headers into seconds from now", async () => {
    const error = await rejectionFor(
      {},
      {
        "x-ratelimit-reset": new Date(Date.now() + 15_000).toUTCString(),
      },
    );
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(10);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(20);
  });

  it("reads reset metadata from error.metadata.headers in the body", async () => {
    const error = await rejectionFor({
      error: {
        message: "Rate limit exceeded",
        metadata: {
          headers: { "X-RateLimit-Reset": String(Date.now() + 30_000) },
        },
      },
    });
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(25);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(35);
  });

  it("reads snake_case reset fields from the body", async () => {
    const error = await rejectionFor({
      error: { ratelimit_reset: 45 },
    });
    expect(error.retryAfterSeconds).toBe(45);
  });

  it("falls back to body language when no structured metadata exists", async () => {
    const error = await rejectionFor({
      error: { message: "try again in 7s" },
    });
    expect(error.retryAfterSeconds).toBe(7);
  });

  it("leaves retryAfterSeconds unset without reset information", async () => {
    const error = await rejectionFor({ error: { message: "slow down" } });
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("parses raw reset values by magnitude", () => {
    expect(parseResetSeconds(0)).toBe(0);
    expect(parseResetSeconds("45")).toBe(45);
    expect(parseResetSeconds(-5)).toBeUndefined();
    expect(parseResetSeconds("not-a-timestamp")).toBeUndefined();
    expect(parseResetSeconds("")).toBeUndefined();
    const epochSeconds = Math.floor(Date.now() / 1000) + 30;
    const fromSeconds = parseResetSeconds(epochSeconds) ?? 0;
    expect(fromSeconds).toBeGreaterThanOrEqual(25);
    expect(fromSeconds).toBeLessThanOrEqual(35);
    const fromMillis = parseResetSeconds(Date.now() + 30_000) ?? 0;
    expect(fromMillis).toBeGreaterThanOrEqual(25);
    expect(fromMillis).toBeLessThanOrEqual(35);
  });
});
