import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config store', () => {
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), 'clai-config-test-'));
    vi.stubEnv('CLAI_CONFIG_DIR', configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function loadConfigStore() {
    return await import('../src/store/config.js');
  }

  it('returns a config with required fields', async () => {
    const { getConfig } = await loadConfigStore();
    const config = getConfig();

    expect(config.defaultProvider).toBeTruthy();
    expect(config.defaultMode).toMatch(/^(ask|agent)$/);
    expect(Array.isArray(config.sandboxRoots)).toBe(true);
    expect(typeof config.pentestAuthorized).toBe('boolean');
    expect(typeof config.providerFallback).toBe('boolean');
    expect(typeof config.telemetry).toBe('boolean');
  });

  it('defaults to nvidia provider', async () => {
    const { getConfig } = await loadConfigStore();
    const config = getConfig();

    expect(config.defaultProvider).toBe('nvidia');
  });

  it('returns correct default model for each provider', async () => {
    const { getProviderModel } = await loadConfigStore();

    expect(getProviderModel('groq')).toBe('llama-3.3-70b-versatile');
    expect(getProviderModel('gemini')).toBe('gemini-3.5-flash');
    expect(getProviderModel('nvidia')).toBe('openai/gpt-oss-20b');
    expect(getProviderModel('ollama')).toBe('llama3.1:8b');
  });

  it('normalizes retired persisted provider models', async () => {
    const { getConfig, getProviderModel, updateConfig } = await loadConfigStore();

    updateConfig({
      defaultProvider: 'nvidia',
      defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      providerModels: {
        groq: 'gemma2-9b-it',
        nvidia: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      },
    });

    expect(getConfig().defaultModel).toBe('openai/gpt-oss-20b');
    expect(getProviderModel('groq')).toBe('llama-3.1-8b-instant');
    expect(getProviderModel('nvidia')).toBe('openai/gpt-oss-20b');
  });
});
