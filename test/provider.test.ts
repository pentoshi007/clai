import { describe, expect, it } from 'vitest';
import { maskSecret, normalizeProvider, redactSecrets } from '../src/llm/provider.js';


describe('provider helpers', () => {
  it('normalizes aliases', () => {
    expect(normalizeProvider('google')).toBe('gemini');
    expect(normalizeProvider('LOCAL')).toBe('ollama');
  });

  it('masks secrets per Requirement 3.6 (last 4 chars visible, prefix masked)', () => {
    expect(maskSecret('sk-proj-secret-middle-OkcA')).toBe('*'.repeat(22) + 'OkcA');
    expect(maskSecret('gsk_abcdef1234567890')).toBe('*'.repeat(16) + '7890');
    expect(maskSecret('short')).toBe('*****');
    expect(maskSecret('')).toBe('');
  });

  it('redacts known key formats', () => {
    expect(redactSecrets('token gsk_abcdef123456')).toContain('gsk_••••••');
    expect(redactSecrets('token AIzaabcdef123456')).toContain('AIza••••••');
  });
});
