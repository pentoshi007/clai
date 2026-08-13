import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('custom providers', () => {
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), 'clai-custom-test-'));
    vi.stubEnv('CLAI_CONFIG_DIR', configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function loadModules() {
    const config = await import('../src/store/config.js');
    const cp = await import('../src/llm/custom-providers.js');
    const provider = await import('../src/llm/provider.js');
    const router = await import('../src/llm/router.js');
    return { config, cp, provider, router };
  }

  it('addCustomProvider persists a definition and resolves its model', async () => {
    const { config, cp } = await loadModules();
    config.addCustomProvider({
      id: 'myllm',
      displayName: 'My LLM',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-custom-1',
    });

    const defs = config.getCustomProviders();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('myllm');

    // getProviderModel falls back to the custom default model.
    expect(config.getProviderModel('myllm' as never)).toBe('gpt-custom-1');

    // A configured model override takes precedence.
    config.setProviderModel('myllm' as never, 'gpt-custom-2');
    expect(config.getProviderModel('myllm' as never)).toBe('gpt-custom-2');
    void cp;
  });

  it('custom providers use endpoints and seed their base URL', async () => {
    const { config } = await loadModules();
    config.addCustomProvider({
      id: 'gw',
      displayName: 'Gateway',
      baseUrl: 'https://gw.example.com/v1',
      defaultModel: 'm1',
    });

    expect(config.providerUsesEndpoints('gw' as never)).toBe(true);
    const endpoints = config.getProviderEndpoints('gw' as never);
    expect(endpoints.urls).toEqual(['https://gw.example.com/v1']);
    expect(config.getActiveProviderEndpoint('gw' as never)).toBe('https://gw.example.com/v1');
  });

  it('normalizeProvider recognises a custom id after it is added', async () => {
    const { config, provider } = await loadModules();
    // The resolver is wired at config-module load time.
    expect(provider.normalizeProvider('myllm')).toBeUndefined();
    config.addCustomProvider({
      id: 'myllm',
      displayName: 'My LLM',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-custom-1',
    });
    expect(provider.normalizeProvider('myllm')).toBe('myllm');
    expect(provider.assertProvider('MyLLM')).toBe('myllm');
  });

  it('getProvider resolves a custom provider implementation', async () => {
    const { config, router } = await loadModules();
    config.addCustomProvider({
      id: 'myllm',
      displayName: 'My LLM',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-custom-1',
    });
    const impl = router.getProvider('myllm' as never);
    expect(impl.id).toBe('myllm');
    expect(impl.displayName).toBe('My LLM');
    expect(impl.defaultModel).toBe('gpt-custom-1');
    // Custom providers accept any reasonably-long key.
    expect(impl.validateKey('sk-anything-long')).toBe(true);
    expect(impl.validateKey('short')).toBe(false);
  });

  it('removeCustomProvider deletes the definition', async () => {
    const { config } = await loadModules();
    config.addCustomProvider({
      id: 'tmp',
      displayName: 'Temp',
      baseUrl: 'https://tmp.example.com/v1',
      defaultModel: 'm1',
    });
    expect(config.removeCustomProvider('tmp')).toBe(true);
    expect(config.getCustomProviders()).toHaveLength(0);
    expect(config.removeCustomProvider('tmp')).toBe(false);
  });

  it('duplicate add throws', async () => {
    const { config } = await loadModules();
    config.addCustomProvider({
      id: 'dup',
      displayName: 'Dup',
      baseUrl: 'https://dup.example.com/v1',
      defaultModel: 'm1',
    });
    expect(() =>
      config.addCustomProvider({
        id: 'dup',
        displayName: 'Dup2',
        baseUrl: 'https://dup2.example.com/v1',
        defaultModel: 'm2',
      }),
    ).toThrow(/already exists/);
  });

  it('custom provider participates in the fallback chain', async () => {
    const { config, router } = await loadModules();
    config.addCustomProvider({
      id: 'myllm',
      displayName: 'My LLM',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'm1',
    });
    // freeOnly off: the custom provider appears after the built-ins.
    const chain = router.buildFallbackChain('groq', false, true);
    expect(chain).toContain('myllm');
    // freeOnly on: custom providers are paid-cloud by default, so excluded.
    const freeChain = router.buildFallbackChain('groq', true, true);
    expect(freeChain).not.toContain('myllm');
  });

  it('normalizeCustomProviderId rejects collisions and bad slugs', async () => {
    const { cp } = await loadModules();
    expect(cp.normalizeCustomProviderId('myllm', ['groq'])).toBe('myllm');
    expect(cp.normalizeCustomProviderId('groq', ['groq'])).toBe('');
    expect(cp.normalizeCustomProviderId('Bad Slug!', [])).toBe('');
    expect(cp.normalizeCustomProviderId('', [])).toBe('');
  });

  it('router resolves custom provider defaultModel (regression: "undefined is not an object")', async () => {
    const { config, router } = await loadModules();
    config.addCustomProvider({
      id: 'omniroute',
      displayName: 'OmniRoute',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'oc/deepseek-v4-flash-free',
    });
    // Before the fix, router.ts indexed `providers[requested]` directly, which
    // returned undefined for a custom id and crashed on `.defaultModel`.
    // getProvider now resolves custom providers from the runtime registry.
    const impl = router.getProvider('omniroute' as never);
    expect(impl.defaultModel).toBe('oc/deepseek-v4-flash-free');
    expect(impl.id).toBe('omniroute');
    // The fallback chain builder also must not crash on custom ids.
    const chain = router.buildFallbackChain('omniroute' as never, false, true);
    expect(chain[0]).toBe('omniroute');
  });

  it('retries a stream once without stream_options when a custom gateway rejects it', async () => {
    const { config, router } = await loadModules();
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'stream_options'" } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    config.addCustomProvider({
      id: 'strict-gateway',
      displayName: 'Strict Gateway',
      baseUrl: 'https://strict.example/v1',
      defaultModel: 'strict-model',
    });
    const provider = router.getProvider('strict-gateway' as never);

    const result = await provider.stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'test-key' },
      () => undefined,
    );
    const nextResult = await provider.stream(
      { messages: [{ role: 'user', content: 'again' }] },
      { apiKey: 'test-key' },
      () => undefined,
    );

    expect(result.text).toBe('ok');
    expect(nextResult.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requests[0]?.stream_options).toEqual({ include_usage: true });
    expect(requests[1]?.stream_options).toBeUndefined();
    expect(requests[2]?.stream_options).toBeUndefined();
    expect(requests[1]).toMatchObject({ model: 'strict-model', stream: true });
    expect(requests[2]).toMatchObject({ model: 'strict-model', stream: true });
  });
});
