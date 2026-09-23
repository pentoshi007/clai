import { afterEach, describe, expect, it, vi } from "vitest";
import { kiroProvider, resolveKiroModel, kiroFallbackModels } from "../src/llm/kiro.js";
import {
  encodeKiroKey,
  decodeKiroKey,
  isKiroOAuthToken,
  assertValidAwsRegion,
  startKiroDeviceAuth,
  startKiroSocialAuth,
  exchangeKiroSocialCode,
  refreshKiroToken,
  listenForKiroSocialCallback,
  readKiroStoredAuth,
  createKiroCliAuthorizationFlow,
  parseKiroCliCallback,
  exchangeKiroPortalCode,
  listenForKiroCliCallback,
  kiroDesktopUserAgent,
  isHeadlessEnvironment,
  KIRO_CLI_CALLBACK_PORT,
  type KiroCredential,
} from "../src/llm/kiro-auth.js";
import { getProvider } from "../src/llm/router.js";
import { normalizeProvider, defaultModels, envVars } from "../src/llm/provider.js";
import { isKnownPatternVisionModel } from "../src/llm/capability/vision-patterns.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { CompletionRequest, ToolDefinition } from "../src/types.js";

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf: Buffer | Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeFrame(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Buffer {
  const headerBufs: Buffer[] = [];
  for (const [name, val] of Object.entries(headers)) {
    const nameBytes = Buffer.from(name, "utf8");
    const valBytes = Buffer.from(val, "utf8");
    const h = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valBytes.length);
    h.writeUInt8(nameBytes.length, 0);
    nameBytes.copy(h, 1);
    h.writeUInt8(7, 1 + nameBytes.length);
    h.writeUInt16BE(valBytes.length, 2 + nameBytes.length);
    valBytes.copy(h, 4 + nameBytes.length);
    headerBufs.push(h);
  }
  const headersBuf = Buffer.concat(headerBufs);
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + headersBuf.length + payloadBuf.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headersBuf.length, 4);
  frame.writeUInt32BE(crc32(frame, 0, 8), 8);
  headersBuf.copy(frame, 12);
  payloadBuf.copy(frame, 12 + headersBuf.length);
  frame.writeUInt32BE(crc32(frame, 0, totalLength - 4), totalLength - 4);
  return frame;
}

function createStreamResponse(frames: Buffer[]) {
  const combined = Buffer.concat(frames);
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(combined));
      controller.close();
    },
  });
  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "application/vnd.amazon.eventstream",
    },
  });
}

describe("Kiro provider integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes expected display name, default model, and aliases", () => {
    expect(getProvider("kiro").displayName).toBe("Kiro AI");
    expect(normalizeProvider("kiro")).toBe("kiro");
    expect(normalizeProvider("kr")).toBe("kiro");
    expect(normalizeProvider("kiro-ai")).toBe("kiro");
    expect(normalizeProvider("kiro.dev")).toBe("kiro");
    expect(normalizeProvider("kiro-desktop")).toBe("kiro");
    expect(normalizeProvider("aws-kiro")).toBe("kiro");

    expect(defaultModels.kiro).toBe("claude-sonnet-4.5");
    expect(envVars.kiro).toBe("KIRO_API_KEY");
  });

  it("validates AWS regions strictly", () => {
    expect(assertValidAwsRegion("us-east-1")).toBe("us-east-1");
    expect(assertValidAwsRegion("eu-west-1")).toBe("eu-west-1");
    expect(assertValidAwsRegion("ap-northeast-1")).toBe("ap-northeast-1");
    expect(() => assertValidAwsRegion("invalid_region")).toThrow();
    expect(() => assertValidAwsRegion("../escape")).toThrow();
  });

  it("encodes, decodes, and validates Kiro keys", () => {
    const cred: KiroCredential = {
      accessToken: "test-access-token-12345",
      refreshToken: "aorAAAAAG-test-refresh",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789:profile/p-12345",
      expiresAt: 1800000000000,
      authMethod: "builder-id",
      region: "us-east-1",
      clientId: "client-id-xyz",
      clientSecret: "client-secret-abc",
    };

    const encoded = encodeKiroKey(cred);
    expect(isKiroOAuthToken(encoded)).toBe(true);

    const decoded = decodeKiroKey(encoded);
    expect(decoded).toMatchObject({
      accessToken: "test-access-token-12345",
      refreshToken: "aorAAAAAG-test-refresh",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789:profile/p-12345",
      authMethod: "builder-id",
      region: "us-east-1",
      clientId: "client-id-xyz",
    });

    expect(kiroProvider.validateKey(encoded)).toBe(true);
    expect(kiroProvider.validateKey("aorAAAAAG-raw-refresh-token")).toBe(true);
    expect(kiroProvider.validateKey("ey.jwt.token")).toBe(true);
    expect(kiroProvider.validateKey("valid-api-key-here")).toBe(true);
    expect(kiroProvider.validateKey("short")).toBe(false);
  });

  it("resolves model variants and strips synthetic suffixes", () => {
    expect(resolveKiroModel("claude-sonnet-4.5")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: false,
      thinking: false,
    });
    expect(resolveKiroModel("claude-sonnet-4.5-thinking")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: false,
      thinking: true,
    });
    expect(resolveKiroModel("claude-sonnet-4.5-agentic")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: true,
      thinking: false,
    });
    expect(resolveKiroModel("claude-sonnet-4.5-thinking-agentic")).toEqual({
      upstream: "claude-sonnet-4.5",
      agentic: true,
      thinking: true,
    });
  });

  it("maps pseudo-models like auto to a real upstream kiro model", () => {
    expect(resolveKiroModel("auto").upstream).toBe(defaultModels.kiro);
    expect(resolveKiroModel("").upstream).toBe(defaultModels.kiro);
    expect(resolveKiroModel("  ").upstream).toBe(defaultModels.kiro);
    expect(resolveKiroModel("auto-thinking")).toEqual({
      upstream: defaultModels.kiro,
      agentic: false,
      thinking: true,
    });
    expect(resolveKiroModel("auto-agentic")).toEqual({
      upstream: defaultModels.kiro,
      agentic: true,
      thinking: false,
    });
    expect(resolveKiroModel("some-unknown-alias").upstream).toBe(defaultModels.kiro);
  });

  it("passes through newer and non-Claude upstream model families", () => {
    expect(resolveKiroModel("claude-opus-5").upstream).toBe("claude-opus-5");
    expect(resolveKiroModel("gpt-6").upstream).toBe("gpt-6");
    expect(resolveKiroModel("gpt-6-thinking").upstream).toBe("gpt-6");
    expect(resolveKiroModel("gpt-6-thinking").thinking).toBe(true);
    expect(resolveKiroModel("o3").upstream).toBe("o3");
    expect(resolveKiroModel("minimax-m2").upstream).toBe("minimax-m2");
    expect(resolveKiroModel("glm-5").upstream).toBe("glm-5");
    expect(resolveKiroModel("qwen3-coder-next").upstream).toBe("qwen3-coder-next");
    expect(resolveKiroModel("deepseek-v4").upstream).toBe("deepseek-v4");
  });

  it("supports vision models", () => {
    expect(isKnownPatternVisionModel("kiro", "claude-sonnet-4.5")).toBe(true);
    expect(isKnownPatternVisionModel("kiro", "claude-opus-5")).toBe(true);
  });

  it("dynamically fetches models and generates thinking/agentic variants", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [
            { modelId: "claude-sonnet-4.5" },
            { modelId: "claude-opus-5" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await kiroProvider.listModels!({
      apiKey: "test-api-key-long",
    });

    expect(models).toContain("claude-sonnet-4.5");
    expect(models).toContain("claude-sonnet-4.5-thinking");
    expect(models).toContain("claude-sonnet-4.5-agentic");
    expect(models).toContain("claude-sonnet-4.5-thinking-agentic");
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("claude-opus-5-thinking");
  });

  it("streams responses with AWS EventStream parsing and handles thinking and tokens", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: "Hello! <thinking>Analyzing request...</thinking>Let's write code." },
    );
    const frame2 = encodeFrame(
      { ":event-type": "metricsEvent" },
      { inputTokens: 42, outputTokens: 28, cachedTokens: 10 },
    );
    const frame3 = encodeFrame(
      { ":event-type": "messageStopEvent" },
      { stopReason: "stop" },
    );

    const fetchMock = vi.fn(async () => createStreamResponse([frame1, frame2, frame3]));
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const request: CompletionRequest = {
      model: "claude-sonnet-4.5-thinking",
      messages: [{ role: "user", content: "Write a test" }],
    };

    const cred = encodeKiroKey({
      accessToken: "token-abc",
      authMethod: "builder-id",
    });

    const result = await kiroProvider.stream!(
      request,
      { apiKey: cred },
      (t) => tokens.push(t),
    );

    expect(tokens.join("")).toBe("Hello! Let's write code.");
    expect(result.text).toBe("Hello! Let's write code.");
    expect(result.reasoningBlock?.text).toBe("Analyzing request...");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({
      promptTokens: 42,
      completionTokens: 28,
      cachedPromptTokens: 10,
    });
  });

  it("supports tool calls streamed via EventStream", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "toolUseEvent" },
      {
        toolUseId: "tool_123",
        name: "bash",
        input: '{"command": "echo hi"}',
        stop: true,
      },
    );
    const frame2 = encodeFrame(
      { ":event-type": "messageStopEvent" },
      { stopReason: "tool_use" },
    );

    const fetchMock = vi.fn(async () => createStreamResponse([frame1, frame2]));
    vi.stubGlobal("fetch", fetchMock);

    const tools: ToolDefinition[] = [
      {
        name: "bash",
        wireName: "bash",
        description: "Run shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ];

    const deltas: unknown[] = [];
    const request: CompletionRequest = {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "Run bash" }],
      tools,
      onToolCallDelta: (d) => deltas.push(d),
    };

    const cred = encodeKiroKey({
      accessToken: "token-abc",
      authMethod: "builder-id",
    });

    const result = await kiroProvider.complete(request, { apiKey: cred });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls?.length).toBe(1);
    expect(result.toolCalls![0]?.name).toBe("bash");
    expect(result.toolCalls![0]?.args).toEqual({ command: "echo hi" });
    expect(deltas.length).toBeGreaterThan(0);
  });

  it("pairs prior toolUses with their toolResults across a tool round-trip", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "done" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "user", content: "find all info about this computer" },
          {
            role: "assistant",
            content: "I'll gather information.",
            toolCalls: [
              { id: "tu_1", name: "shell.exec", args: { command: "system_profiler SPHardwareDataType" } },
              { id: "tu_2", name: "shell.exec", args: { command: "sysctl -a" } },
            ],
          },
          { role: "tool", toolCallId: "tu_1", content: "hw ok" },
          { role: "tool", toolCallId: "tu_2", content: "sysctl ok" },
        ],
      },
      { apiKey: cred },
    );

    const conv = capturedBody?.conversationState as Record<string, unknown>;
    const history = conv?.history as Array<Record<string, unknown>>;
    const current = conv?.currentMessage as Record<string, unknown>;

    const assistantTurn = history.find((h) => h.assistantResponseMessage) as
      | Record<string, unknown>
      | undefined;
    const arm = assistantTurn?.assistantResponseMessage as Record<string, unknown>;
    const toolUses = arm?.toolUses as Array<{ toolUseId: string }> | undefined;
    expect(toolUses?.map((t) => t.toolUseId)).toEqual(["tu_1", "tu_2"]);

    const resultsUser =
      (history[history.length - 1] as Record<string, unknown>)?.userInputMessage ??
      current.userInputMessage;
    const ctx = (resultsUser as Record<string, unknown>)
      .userInputMessageContext as Record<string, unknown>;
    const toolResults = ctx?.toolResults as Array<{ toolUseId: string }> | undefined;
    expect(toolResults?.map((t) => t.toolUseId)).toEqual(["tu_1", "tu_2"]);
  });

  it("handles automatic token refresh on 401 error", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({
            accessToken: "new-fresh-access-token",
            refreshToken: "new-refresh-token",
            expiresIn: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      callCount++;
      if (callCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }

      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "Refreshed and running!" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = encodeKiroKey({
      accessToken: "old-expired-token",
      refreshToken: "valid-refresh-token",
      clientId: "cid",
      clientSecret: "csec",
      authMethod: "builder-id",
    });

    const statuses: string[] = [];
    const result = await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "hello" }],
      },
      { apiKey: cred },
      (msg) => statuses.push(msg),
    );

    expect(result.text).toBe("Refreshed and running!");
    expect(statuses.some((s) => s.includes("refresh"))).toBe(true);
  });

  it("derives deterministic conversation ID when session affinity is present", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "turn 1" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = encodeKiroKey({
      accessToken: "token-abc",
      authMethod: "builder-id",
    });

    await withSessionAffinity("session-test-affinity-uuid", async () => {
      await kiroProvider.complete(
        {
          model: "claude-sonnet-4.5",
          messages: [{ role: "user", content: "first turn" }],
        },
        { apiKey: cred },
      );
    });

    expect(capturedBody).toBeDefined();
    const convState = capturedBody?.conversationState as Record<string, unknown>;
    expect(typeof convState?.conversationId).toBe("string");
    expect(convState?.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("derives a content-stable conversation ID when no session affinity is set", async () => {
    const ids: string[] = [];
    const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      ids.push(String((body.conversationState as Record<string, unknown>).conversationId));
      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "ok" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    const msgs = [{ role: "user" as const, content: "same first message" }];
    await kiroProvider.complete({ model: "claude-sonnet-4.5", messages: msgs }, { apiKey: cred });
    await kiroProvider.complete({ model: "claude-sonnet-4.5", messages: msgs }, { apiKey: cred });
    await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "different message" }] },
      { apiKey: cred },
    );

    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("emits adaptive-thinking fields for Claude and native reasoning for GPT", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_i: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "ok" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    await kiroProvider.complete(
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: true, effort: "high" },
      },
      { apiKey: cred },
    );
    await kiroProvider.complete(
      {
        model: "gpt-6",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: true, effort: "medium" },
      },
      { apiKey: cred },
    );
    await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: cred },
    );

    const claude = bodies[0]!;
    const claudeMsg = (claude.conversationState as Record<string, unknown>)
      .currentMessage as Record<string, unknown>;
    const claudeUim = claudeMsg.userInputMessage as Record<string, unknown>;
    expect(String(claudeUim.content)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(claude.additionalModelRequestFields).toEqual({
      output_config: { effort: "high" },
      thinking: { type: "adaptive", display: "summarized" },
    });

    const gpt = bodies[1]!;
    const gptMsg = (gpt.conversationState as Record<string, unknown>)
      .currentMessage as Record<string, unknown>;
    expect(String((gptMsg.userInputMessage as Record<string, unknown>).content)).not.toContain(
      "thinking_mode",
    );
    expect(gpt.additionalModelRequestFields).toEqual({ reasoning: { effort: "medium" } });

    const plain = bodies[2]!;
    expect(plain.additionalModelRequestFields).toBeUndefined();
  });

  it("reads cacheRead/cacheWrite input tokens from metering events", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: "cached" },
    );
    const frame2 = encodeFrame(
      { ":event-type": "meteringEvent" },
      {
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadInputTokens: 700,
        cacheWriteInputTokens: 300,
      },
    );
    const fetchMock = vi.fn(async () => createStreamResponse([frame1, frame2]));
    vi.stubGlobal("fetch", fetchMock);
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    const result = await kiroProvider.complete(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] },
      { apiKey: cred },
    );

    expect(result.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 50,
      cachedPromptTokens: 700,
      cacheCreationTokens: 300,
      uncachedPromptTokens: 300,
    });
  });

  it("extracts code and exchanges social token from kiro:// redirect URL", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          accessToken: "mock-social-access-token",
          refreshToken: "mock-social-refresh-token",
          expiresIn: 3600,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = await exchangeKiroSocialCode(
      "kiro://kiro.kiroAgent/authenticate-success?code=social_test_code_123&state=abc",
      "verifier_456",
      "google",
    );

    expect(capturedBody?.code).toBe("social_test_code_123");
    expect(capturedBody?.code_verifier).toBe("verifier_456");
    expect(cred.accessToken).toBe("mock-social-access-token");
    expect(cred.authMethod).toBe("google");
  });

  it("extracts code from query string and rejects redirect errors", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          accessToken: `token-for-${String(body.code)}`,
          expiresIn: 3600,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = await exchangeKiroSocialCode(
      "?code=extracted_query_code&state=xyz",
      "verifier_789",
      "github",
    );
    expect(cred.accessToken).toBe("token-for-extracted_query_code");
    expect(cred.authMethod).toBe("github");

    await expect(
      exchangeKiroSocialCode(
        "kiro://kiro.kiroAgent/authenticate-success?error=access_denied&error_description=User+denied+access",
        "verifier",
      ),
    ).rejects.toThrow("User denied access");
  });

  it("handles loopback callback server lifecycle and receives code", async () => {
    let receivedCode: string | undefined;
    const handle = await listenForKiroSocialCallback({
      onCode: (code) => {
        receivedCode = code;
      },
    });

    expect(handle.port).toBeGreaterThan(0);

    const res = await fetch(
      `http://127.0.0.1:${handle.port}/callback?url=${encodeURIComponent("kiro://kiro.kiroAgent/authenticate-success?code=loopback_code_ok")}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Kiro AI Authenticated");
    expect(receivedCode).toBe("kiro://kiro.kiroAgent/authenticate-success?code=loopback_code_ok");

    handle.close();
  });

  describe("kiro-cli portal flow", () => {
    it("builds an authorization flow matching kiro-cli's portal URL", () => {
      const flow = createKiroCliAuthorizationFlow();
      const url = new URL(flow.authorizeUrl);

      expect(url.origin + url.pathname).toBe("https://app.kiro.dev/signin");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3128");
      expect(url.searchParams.get("redirect_from")).toBe("kirocli");
      expect(url.searchParams.get("state")).toBe(flow.state);
      expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.has("idp")).toBe(false);
      expect(url.searchParams.has("prompt")).toBe(false);
      expect(flow.codeVerifier).toBeTruthy();
    });

    it("parses the kiro-cli portal callback URL", () => {
      const cb = parseKiroCliCallback(
        "http://localhost:3128/oauth/callback?login_option=google&code=abc123&state=deadbeef",
      );
      expect(cb).toEqual({
        code: "abc123",
        loginOption: "google",
        state: "deadbeef",
        path: "/oauth/callback",
      });
    });

    it("parses signin/callback path and bare query strings", () => {
      const a = parseKiroCliCallback(
        "http://localhost:3128/signin/callback?login_option=github&code=gh_code",
      );
      expect(a.path).toBe("/signin/callback");
      expect(a.loginOption).toBe("github");
      expect(a.code).toBe("gh_code");
      expect(a.state).toBeUndefined();

      const b = parseKiroCliCallback("code=plain_code&login_option=google");
      expect(b.code).toBe("plain_code");
      expect(b.loginOption).toBe("google");
    });

    it("rejects error callbacks and missing fields", () => {
      expect(() =>
        parseKiroCliCallback(
          "http://localhost:3128/oauth/callback?error=access_denied&error_description=denied",
        ),
      ).toThrow("denied");
      expect(() =>
        parseKiroCliCallback("http://localhost:3128/oauth/callback?login_option=google"),
      ).toThrow("code");
      expect(() =>
        parseKiroCliCallback("http://localhost:3128/oauth/callback?code=only"),
      ).toThrow("login_option");
    });

    it("exchanges a portal code with kiro-cli's token body and UA", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      let capturedHeaders: Headers | undefined;
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            accessToken: "portal-access-token",
            refreshToken: "portal-refresh-token",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/p-9",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const cred = await exchangeKiroPortalCode(
        {
          code: "portal_code",
          loginOption: "google",
          path: "/oauth/callback",
        },
        "portal_verifier",
      );

      expect(capturedBody).toMatchObject({
        code: "portal_code",
        code_verifier: "portal_verifier",
        redirect_uri:
          "http://localhost:3128/oauth/callback?login_option=google",
        invitation_code: null,
      });
      expect(capturedHeaders?.get("user-agent")).toMatch(/^KiroIDE-\d+\.\d+\.\d+-[0-9a-f]{16}$/);
      expect(cred.accessToken).toBe("portal-access-token");
      expect(cred.refreshToken).toBe("portal-refresh-token");
      expect(cred.authMethod).toBe("google");
      expect(cred.profileArn).toContain("us-east-1");
    });

    it("listens on port 3128 and resolves on the portal callback", async () => {
      const state = "0123456789abcdef0123456789abcdef";
      const server = listenForKiroCliCallback({ expectedState: state, timeoutMs: 10_000 });
      expect(server.port).toBe(KIRO_CLI_CALLBACK_PORT);

      const res = await fetch(
        `http://127.0.0.1:${KIRO_CLI_CALLBACK_PORT}/oauth/callback?login_option=github&code=loop_code&state=${state}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Kiro AI Authenticated");

      const cb = await server.promise;
      expect(cb).toMatchObject({
        code: "loop_code",
        loginOption: "github",
        state,
        path: "/oauth/callback",
      });

      server.close();
    });

    it("rejects on state mismatch", async () => {
      const server = listenForKiroCliCallback({
        expectedState: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        timeoutMs: 10_000,
      });

      const expectation = expect(server.promise).rejects.toThrow(/state/i);

      const res = await fetch(
        `http://127.0.0.1:${KIRO_CLI_CALLBACK_PORT}/oauth/callback?login_option=google&code=x&state=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      );
      expect(res.status).toBe(400);
      await expectation;
      server.close();
    });

    it("produces a desktop user agent with a stable machine fingerprint", () => {
      const ua = kiroDesktopUserAgent();
      expect(ua).toMatch(/^KiroIDE-\d+\.\d+\.\d+-[0-9a-f]{16}$/);
      expect(kiroDesktopUserAgent()).toBe(ua);
    });

    it("detects headless SSH and headless Linux environments", () => {
      const saved = {
        SSH_CONNECTION: process.env.SSH_CONNECTION,
        SSH_CLIENT: process.env.SSH_CLIENT,
        SSH_TTY: process.env.SSH_TTY,
        DISPLAY: process.env.DISPLAY,
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      };
      const restore = () => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
          else (process.env as Record<string, string | undefined>)[k] = v;
        }
      };

      try {
        delete process.env.SSH_CONNECTION;
        delete process.env.SSH_CLIENT;
        delete process.env.SSH_TTY;

        process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
        expect(isHeadlessEnvironment()).toBe(true);
        delete process.env.SSH_CONNECTION;

        process.env.SSH_TTY = "/dev/pts/0";
        expect(isHeadlessEnvironment()).toBe(true);
        delete process.env.SSH_TTY;

        if (process.platform === "linux") {
          delete process.env.DISPLAY;
          delete process.env.WAYLAND_DISPLAY;
          expect(isHeadlessEnvironment()).toBe(true);
          process.env.DISPLAY = ":0";
          expect(isHeadlessEnvironment()).toBe(false);
        }
      } finally {
        restore();
      }
    });
  });
});
