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

  it('defaults to the keyless free provider', async () => {
    const { getConfig } = await loadConfigStore();
    const config = getConfig();

    expect(config.defaultProvider).toBe('free');
    expect(config.defaultModel).toBe('free-2/kilo-auto/free');
  });

  it('returns correct default model for each provider', async () => {
    const { getProviderModel } = await loadConfigStore();

    expect(getProviderModel('free')).toBe('free-2/kilo-auto/free');
    expect(getProviderModel('openrouter')).toBe('meta-llama/llama-3.3-70b-instruct:free');
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
        gemini: 'gemini-2.0-flash',
        nvidia: 'nvidia/llama-3.3-nemotron-super-49b-v1',
      },
    });

    expect(getConfig().defaultModel).toBe('openai/gpt-oss-20b');
    expect(getProviderModel('gemini')).toBe('gemini-3.5-flash');
    expect(getProviderModel('nvidia')).toBe('openai/gpt-oss-20b');
  });

  it('keeps the active default model when configuring another provider', async () => {
    const { getConfig, getProviderModel, setProviderModel } = await loadConfigStore();
    const before = getConfig().defaultModel;

    setProviderModel('modal', 'Qwen/Qwen3.8-2.4T-A95B');

    expect(getProviderModel('modal')).toBe('Qwen/Qwen3.8-2.4T-A95B');
    expect(getConfig().defaultModel).toBe(before);
  });

  it('updates the active default model with its provider model', async () => {
    const { getConfig, setDefaultProvider, setProviderModel } = await loadConfigStore();
    setDefaultProvider('modal');
    setProviderModel('modal', 'moonshotai/Kimi-K3');
    expect(getConfig().defaultModel).toBe('moonshotai/Kimi-K3');
  });

  it('supports disableKeychain property', async () => {
    const { getConfig, updateConfig } = await loadConfigStore();
    expect(getConfig().disableKeychain).toBe(false);

    updateConfig({ disableKeychain: true });
    expect(getConfig().disableKeychain).toBe(true);
  });

  it('defaults reliability experiment flags (E1–E6) to safe-on', async () => {
    const { getConfig } = await loadConfigStore();
    const c = getConfig();
    expect(c.softEarlyCompact).toBe(true);
    expect(c.softCompactTokenBudget).toBeUndefined();
    expect(c.autoCompactRequestTokens).toBe(180_000);
    expect(c.fsPassthroughCapChars).toBe(64_000);
    expect(c.adaptiveMaxTokens).toBe(true);
    expect(c.freeTierContextGuard).toBe(true);
    expect(c.toolResultDedup).toBe(true);
    expect(c.slimNativePrompt).toBe(true);
  });

  it('allows disabling reliability experiments via updateConfig', async () => {
    const { getConfig, updateConfig } = await loadConfigStore();
    updateConfig({
      softEarlyCompact: false,
      adaptiveMaxTokens: false,
      toolResultDedup: false,
      slimNativePrompt: false,
      freeTierContextGuard: false,
    });
    const c = getConfig();
    expect(c.softEarlyCompact).toBe(false);
    expect(c.adaptiveMaxTokens).toBe(false);
    expect(c.toolResultDedup).toBe(false);
    expect(c.slimNativePrompt).toBe(false);
    expect(c.freeTierContextGuard).toBe(false);
  });

  it('supports permissions property and defaults to allow-all', async () => {
    const { getConfig, updateConfig } = await loadConfigStore();
    expect(getConfig().permissions).toBe('allow-all');

    updateConfig({ permissions: 'default' });
    expect(getConfig().permissions).toBe('default');
  });
});
