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
    expect(typeof config.telemetry).toBe('boolean');
    expect(typeof config.autoUpdateCheck).toBe('boolean');
    expect(typeof config.freeOnly).toBe('boolean');
  });

  it('defaults to nvidia provider', async () => {
    const { getConfig } = await loadConfigStore();
    const config = getConfig();

    expect(config.defaultProvider).toBe('nvidia');
  });

  it('defaults to free-only and no automatic update checks', async () => {
    const { getConfig } = await loadConfigStore();
    const config = getConfig();

    expect(config.freeOnly).toBe(true);
    expect(config.autoUpdateCheck).toBe(false);
  });

  it('returns correct default model for each provider', async () => {
    const { getProviderModel } = await loadConfigStore();

    expect(getProviderModel('groq')).toBe('llama-3.3-70b-versatile');
    expect(getProviderModel('gemini')).toBe('gemini-2.0-flash');
    expect(getProviderModel('nvidia')).toBe('moonshotai/kimi-k2.6');
    expect(getProviderModel('ollama')).toBe('llama3.1:8b');
  });
});
