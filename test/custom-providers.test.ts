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
    const { setProviderKeys } = await import('../src/store/keys.js');
    await setProviderKeys('strict-gateway' as never, ['test-key']);
    const provider = router.getProvider('strict-gateway' as never);

    const result = await router.streamWithProvider(
      { provider: 'strict-gateway' as never, messages: [{ role: 'user', content: 'hi' }] },
      () => undefined,
      { maxRetries: 0 },
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
    expect(
      result.operationUsage?.attempts.map((attempt) => attempt.reason),
    ).toEqual(['initial', 'provider-retry']);
    expect(
      result.operationUsage?.attempts.map((attempt) => attempt.outcome),
    ).toEqual(['failure', 'success']);
  });

  it('dispatches through the resolved endpoint override, not the stored base URL', async () => {
    const { config, router } = await loadModules();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'rotated',
      displayName: 'Rotated',
      baseUrl: 'https://old.example/v1',
      defaultModel: 'm1',
    });
    const provider = router.getProvider('rotated' as never);
    await provider.complete(
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k', baseUrl: 'https://new.example/v1' },
    );
    expect(urls[0]).toContain('https://new.example/v1/chat/completions');
  });

  it('never interprets an API-key env var as an endpoint override', async () => {
    const { config } = await loadModules();
    config.addCustomProvider({
      id: 'envgw',
      displayName: 'Env Gateway',
      baseUrl: 'https://env.example/v1',
      envVar: 'ENVGW_API_KEY',
      defaultModel: 'm1',
    });
    vi.stubEnv('ENVGW_API_KEY', 'sk-secret-value');
    expect(config.getActiveProviderEndpoint('envgw' as never)).toBe(
      'https://env.example/v1',
    );
    config.addCustomProvider({
      id: 'envgw2',
      displayName: 'Env Gateway 2',
      baseUrl: 'https://env2.example/v1',
      baseUrlEnv: 'ENVGW2_BASE_URL',
      defaultModel: 'm1',
    });
    vi.stubEnv('ENVGW2_BASE_URL', 'https://override.example/v1');
    expect(config.getActiveProviderEndpoint('envgw2' as never)).toBe(
      'https://override.example/v1',
    );
  });

  it('omits optional reasoning controls on undeclared routes', async () => {
    const { config, router } = await loadModules();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'quiet',
      displayName: 'Quiet',
      baseUrl: 'https://quiet.example/v1',
      defaultModel: 'm1',
    });
    await router.getProvider('quiet' as never).complete(
      { messages: [{ role: 'user', content: 'hi' }], thinking: { enabled: true, effort: 'high' } },
      { apiKey: 'k' },
    );
    expect(bodies[0]?.reasoning_effort).toBeUndefined();
    expect(bodies[0]?.reasoning).toBeUndefined();
  });

  it('sends reasoning controls when the profile declares the effort dialect', async () => {
    const { config, router } = await loadModules();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'loud',
      displayName: 'Loud',
      baseUrl: 'https://loud.example/v1',
      defaultModel: 'm1',
      profile: { reasoning: { controlDialect: 'openai-effort' } },
    });
    await router.getProvider('loud' as never).complete(
      { messages: [{ role: 'user', content: 'hi' }], thinking: { enabled: true, effort: 'high' } },
      { apiKey: 'k' },
    );
    expect(bodies[0]?.reasoning_effort).toBe('high');
  });

  it('does not issue a second request when stream_options support was declared', async () => {
    const { config, router } = await loadModules();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "Unsupported parameter: 'stream_options'" } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    config.addCustomProvider({
      id: 'declared',
      displayName: 'Declared',
      baseUrl: 'https://declared.example/v1',
      defaultModel: 'm1',
      profile: { streamOptions: 'supported' },
    });
    const provider = router.getProvider('declared' as never);
    await expect(
      provider.stream(
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'k' },
        () => undefined,
      ),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits stream_options from the first request when declared unsupported', async () => {
    const { config, router } = await loadModules();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'nostreamopts',
      displayName: 'No StreamOpts',
      baseUrl: 'https://ns.example/v1',
      defaultModel: 'm1',
      profile: { streamOptions: 'unsupported' },
    });
    const result = await router.getProvider('nostreamopts' as never).stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k' },
      () => undefined,
    );
    expect(result.text).toBe('ok');
    expect(bodies[0]?.stream_options).toBeUndefined();
  });

  it('works keyless when the profile declares none-keyless auth', async () => {
    const { config, router } = await loadModules();
    const headersSeen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        headersSeen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'keyless',
      displayName: 'Keyless',
      baseUrl: 'https://keyless.example/v1',
      defaultModel: 'm1',
      profile: { authType: 'none-keyless' },
    });
    const result = await router
      .getProvider('keyless' as never)
      .complete({ messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(result.text).toBe('ok');
    expect(headersSeen[0]?.authorization).toBeUndefined();
  });

  it('resolves custom header auth with env references', async () => {
    const { config, router } = await loadModules();
    vi.stubEnv('GW_TOKEN', 'tok-123');
    const headersSeen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        headersSeen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'hdr',
      displayName: 'Header Auth',
      baseUrl: 'https://hdr.example/v1',
      defaultModel: 'm1',
      profile: { authType: 'custom-headers', headers: { 'x-api-key': '${GW_TOKEN}' } },
    });
    await router
      .getProvider('hdr' as never)
      .complete({ messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(headersSeen[0]?.['x-api-key']).toBe('tok-123');
    expect(headersSeen[0]?.authorization).toBeUndefined();
  });

  it('fails locally when a declared header env reference is unset', async () => {
    const { config, router } = await loadModules();
    vi.stubGlobal('fetch', vi.fn());
    config.addCustomProvider({
      id: 'missingenv',
      displayName: 'Missing Env',
      baseUrl: 'https://me.example/v1',
      defaultModel: 'm1',
      profile: { authType: 'custom-headers', headers: { 'x-api-key': '${NO_SUCH_ENV_XYZ}' } },
    });
    await expect(
      router
        .getProvider('missingenv' as never)
        .complete({ messages: [{ role: 'user', content: 'hi' }] }, { apiKey: 'k' }),
    ).rejects.toThrow('NO_SUCH_ENV_XYZ');
  });

  it('selects native tools only when the profile declares support', async () => {
    const { config } = await loadModules();
    const { resolveToolDialect } = await import('../src/llm/capabilities.js');
    config.addCustomProvider({
      id: 'toolful',
      displayName: 'Toolful',
      baseUrl: 'https://toolful.example/v1',
      defaultModel: 'm1',
      profile: { tools: 'supported' },
    });
    config.addCustomProvider({
      id: 'toolless',
      displayName: 'Toolless',
      baseUrl: 'https://toolless.example/v1',
      defaultModel: 'm1',
      profile: { tools: 'unsupported' },
    });
    config.addCustomProvider({
      id: 'toolunknown',
      displayName: 'Tool Unknown',
      baseUrl: 'https://tu.example/v1',
      defaultModel: 'm1',
    });
    expect(resolveToolDialect('toolful' as never, 'm1')).toBe('openai');
    expect(resolveToolDialect('toolless' as never, 'm1')).toBe('none');
    expect(resolveToolDialect('toolunknown' as never, 'm1')).toBe('none');
  });

  it('keeps existing definition fields when a profile is added later', async () => {
    const { config } = await loadModules();
    config.addCustomProvider({
      id: 'legacy',
      displayName: 'Legacy',
      baseUrl: 'https://legacy.example/v1',
      envVar: 'LEGACY_KEY',
      defaultModel: 'm1',
      usageAliases: { promptTokens: 'input_count' },
    });
    const stored = config.getCustomProviders()[0]!;
    expect(stored.usageAliases?.promptTokens).toBe('input_count');
    expect(stored.envVar).toBe('LEGACY_KEY');
    const { customProviderProfileErrors } = await import('../src/llm/custom-providers.js');
    expect(customProviderProfileErrors(stored)).toEqual([]);
  });

  it('round-trips declared reasoning_details and thought-signature extensions losslessly', async () => {
    const { config, router } = await loadModules();
    const details = {
      type: 'reasoning.encrypted',
      id: 'detail-1',
      payload: { opaque: ['a', 'b'], unknown_extension: true },
    };
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  reasoning_content: 'check the file',
                  reasoning_details: details,
                  extra_content: { google: { thought_signature: 'custom-signature' } },
                  tool_calls: [
                    {
                      id: 'custom-tool',
                      type: 'function',
                      function: { name: 'fs_read', arguments: '{"path":"a.md"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    config.addCustomProvider({
      id: 'detailgw',
      displayName: 'Detail Gateway',
      baseUrl: 'https://details.example/v1',
      defaultModel: 'detail-model',
      profile: {
        reasoning: {
          outputShapes: ['reasoning-content', 'structured-details', 'thought-signature'],
        },
        tools: 'supported',
      },
    });
    const result = await router.getProvider('detailgw' as never).complete(
      {
        messages: [{ role: 'user', content: 'inspect the file' }],
        tools: [
          {
            name: 'fs.read',
            wireName: 'fs_read',
            description: 'read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
        toolChoice: 'auto',
      },
      { apiKey: 'k' },
    );
    expect(result.reasoningArtifacts?.map((artifact) => artifact.kind)).toEqual([
      'plaintext',
      'structured-details',
      'thought-signature',
    ]);
    expect(result.reasoningArtifacts?.[1]?.raw).toEqual(details);

    const { appendAssistantWithTools } = await import('../src/agent/tool-history.js');
    const { toOpenAiToolMessages } = await import('../src/llm/adapters/openai-tools.js');
    const { createReasoningArtifactReplayTarget } = await import(
      '../src/llm/reasoning-artifacts.js'
    );
    const history: import('../src/types.js').ChatMessage[] = [];
    appendAssistantWithTools(
      history,
      '',
      result.toolCalls ?? [],
      result.reasoningBlock,
      result.reasoningArtifacts,
    );
    const wire = toOpenAiToolMessages(history, (message) => message.content, {
      target: createReasoningArtifactReplayTarget({
        provider: 'detailgw' as never,
        model: 'detail-model',
        dialect: 'openai-compatible',
        endpoint: 'https://details.example/v1',
      }),
    })[0] as Record<string, unknown>;
    expect(wire.reasoning_content).toBe('check the file');
    expect(wire.reasoning_details).toEqual(details);
    expect(wire.extra_content).toEqual({
      google: { thought_signature: 'custom-signature' },
    });
  });

  it('rejects a natural-EOF stream unless the profile explicitly accepts it', async () => {
    const { config, router } = await loadModules();
    const truncated =
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(truncated, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    config.addCustomProvider({
      id: 'strict-eof',
      displayName: 'Strict EOF',
      baseUrl: 'https://strict-eof.example/v1',
      defaultModel: 'm1',
    });
    await expect(
      router.getProvider('strict-eof' as never).stream(
        { messages: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'k' },
        () => undefined,
      ),
    ).rejects.toMatchObject({ name: 'PartialStreamError' });

    config.addCustomProvider({
      id: 'lenient-eof',
      displayName: 'Lenient EOF',
      baseUrl: 'https://lenient-eof.example/v1',
      defaultModel: 'm1',
      profile: { terminal: { naturalEofAccepted: true } },
    });
    const result = await router.getProvider('lenient-eof' as never).stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k' },
      () => undefined,
    );
    expect(result.text).toBe('partial');
  });
});



describe("configured compatible usage aliases", () => {
  it("normalizes configured cache and reasoning counters without changing request controls", async () => {
    vi.resetModules();
    const configDir = mkdtempSync(join(tmpdir(), "clai-custom-usage-test-"));
    vi.stubEnv("CLAI_CONFIG_DIR", configDir);
    try {
      const { config, router } = await (async () => {
        const config = await import("../src/store/config.js");
        const router = await import("../src/llm/router.js");
        return { config, router };
      })();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: {
                input_count: 120,
                output_count: 20,
                cache: { hit: 96, miss: 24 },
                reasoning_count: 12,
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      );
      config.addCustomProvider({
        id: "usage-gateway",
        displayName: "Usage Gateway",
        baseUrl: "https://usage.example/v1",
        defaultModel: "usage-model",
        usageAliases: {
          promptTokens: "input_count",
          completionTokens: "output_count",
          cachedPromptTokens: "cache.hit",
          uncachedPromptTokens: "cache.miss",
          reasoningTokens: "reasoning_count",
        },
      });

      const result = await router.getProvider("usage-gateway" as never).complete(
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "test-key" },
      );

      expect(result.usage).toMatchObject({
        promptTokens: 120,
        completionTokens: 20,
        totalTokens: 140,
        cachedPromptTokens: 96,
        uncachedPromptTokens: 24,
        reasoningTokens: 12,
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});