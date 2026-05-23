import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpFetch } from '../src/tools/http.js';

const originalFetch = globalThis.fetch;

describe('tools – http.fetch', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof url === 'string' ? url : url.toString();
      if (target.includes('/status/404')) {
        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
      const body = JSON.stringify({ url: target, method: init?.method ?? 'GET' });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns ok and truncates output to maxBytes', async () => {
    const result = await httpFetch('https://example.test/get', { maxBytes: 10 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(200);
    expect(result.output.length).toBeLessThanOrEqual(10);
  });

  it('returns not-ok for 404', async () => {
    const result = await httpFetch('https://example.test/status/404');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(404);
  });
});

import { shellExec } from "../src/tools/shell.js";

describe("shellExec live output", () => {
  it("streams chunks via onOutput before the promise resolves", async () => {
    const chunks: string[] = [];
    const result = await shellExec({
      command: "echo hello && echo world",
      onOutput: (chunk) => chunks.push(chunk),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    // At least one chunk should have arrived live, not just at the end.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("world");
  });

  it("reports stderr through the same onOutput stream channel", async () => {
    const events: Array<{ stream: string; text: string }> = [];
    const result = await shellExec({
      command: "echo oops 1>&2",
      onOutput: (chunk, stream) => events.push({ stream, text: chunk }),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(events.some((e) => e.stream === "stderr" && e.text.includes("oops"))).toBe(true);
  });
});
