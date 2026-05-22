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
