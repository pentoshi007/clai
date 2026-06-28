import { describe, expect, it } from 'vitest';
import { maskSecret, normalizeProvider, redactSecrets } from '../src/llm/provider.js';


describe('provider helpers', () => {
  it('normalizes aliases', () => {
    expect(normalizeProvider('google')).toBe('gemini');
    expect(normalizeProvider('LOCAL')).toBe('ollama');
    expect(normalizeProvider('kimchi')).toBe('kimchi');
    expect(normalizeProvider('aws-mantle')).toBe('aws-mantle');
    expect(normalizeProvider('castai')).toBe('kimchi');
  });

  it('masks secrets showing first 4 and last 4 chars with fixed-width separator', () => {
    expect(maskSecret('sk-proj-secret-middle-OkcA')).toBe('sk-p••••OkcA');
    expect(maskSecret('gsk_abcdef1234567890')).toBe('gsk_••••7890');
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('')).toBe('••••••••');
  });

  it('redacts known key formats', () => {
    expect(redactSecrets('token gsk_abcdef123456')).toContain('gsk_••••••');
    expect(redactSecrets('token AIzaabcdef123456')).toContain('AIza••••••');
  });
});
