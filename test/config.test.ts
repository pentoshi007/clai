import { describe, expect, it } from 'vitest';
import { getConfig, getProviderModel, setDefaultMode, setProviderModel } from '../src/store/config.js';

describe('config store', () => {
  it('returns a config with required fields', () => {
    const config = getConfig();
    expect(config.defaultProvider).toBeTruthy();
    expect(config.defaultMode).toMatch(/^(ask|agent)$/);
    expect(Array.isArray(config.sandboxRoots)).toBe(true);
    expect(typeof config.pentestAuthorized).toBe('boolean');
    expect(typeof config.telemetry).toBe('boolean');
  });

  it('defaults to groq provider', () => {
    const config = getConfig();
    expect(config.defaultProvider).toBe('groq');
  });

  it('returns correct default model for each provider', () => {
    expect(getProviderModel('groq')).toBe('llama-3.3-70b-versatile');
    expect(getProviderModel('gemini')).toBe('gemini-2.0-flash');
    expect(getProviderModel('ollama')).toBe('llama3.1:8b');
  });
});
