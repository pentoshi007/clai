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
});
