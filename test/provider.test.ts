import { describe, expect, it } from 'vitest';
import { maskSecret, normalizeProvider, redactSecrets } from '../src/llm/provider.js';


describe('provider helpers', () => {
  it('normalizes aliases', () => {
    expect(normalizeProvider('google')).toBe('gemini');
    expect(normalizeProvider('LOCAL')).toBe('ollama');
  });

  it('masks secrets without leaking middle content', () => {
    expect(maskSecret('sk-proj-secret-middle-OkcA')).toBe('sk-••••••OkcA');
    expect(maskSecret('gsk_abcdef1234567890')).toBe('gsk_••••••7890');
  });

  it('redacts known key formats', () => {
    expect(redactSecrets('token gsk_abcdef123456')).toContain('gsk_••••••');
    expect(redactSecrets('token AIzaabcdef123456')).toContain('AIza••••••');
  });
});
