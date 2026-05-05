import { describe, expect, it, vi, beforeEach } from 'vitest';
import { httpFetch } from '../src/tools/http.js';

describe('tools – http.fetch', () => {
  it('returns ok and truncated output for successful requests', async () => {
    const result = await httpFetch('https://httpbin.org/get', { maxBytes: 500 });
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(500);
  });

  it('returns not-ok for 404', async () => {
    const result = await httpFetch('https://httpbin.org/status/404');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(404);
  });
});
