import { afterEach, describe, expect, it, vi } from "vitest";
import { kiroProvider, resolveKiroModel, kiroFallbackModels, fetchKiroUsageLimits, resetKiroModelCacheForTesting } from "../src/llm/kiro.js";
import { formatKiroQuotaSection } from "../src/ui-core/commands/session-commands.js";
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
import { needsEffortPreflight } from "../src/llm/wire/effort-preflight.js";
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
    resetKiroModelCacheForTesting();
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

  it("fallback catalog spans free and paid tiers with only resolvable model ids", () => {
    expect(kiroFallbackModels).toContain("auto");
    expect(kiroFallbackModels).toContain("claude-sonnet-4.5");
    expect(kiroFallbackModels).toContain("claude-sonnet-4.5-thinking");
    expect(kiroFallbackModels).toContain("deepseek-3.2");
    expect(kiroFallbackModels).toContain("glm-5");
    expect(kiroFallbackModels).toContain("qwen3-coder-next");
    for (const id of kiroFallbackModels) {
      expect(id.startsWith("-")).toBe(false);
      const resolved = resolveKiroModel(id);
      expect(resolved.upstream.length).toBeGreaterThan(0);
    }
  });

  it("dynamically fetches models and generates thinking/agentic variants", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [
            {
              modelId: "auto",
              modelName: "Auto",
              tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 },
              supportedInputTypes: ["TEXT", "IMAGE"],
            },
            {
              modelId: "claude-sonnet-4.5",
              tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
              supportedInputTypes: ["TEXT", "IMAGE"],
            },
            {
              modelId: "glm-5",
              tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
              supportedInputTypes: ["TEXT"],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const models = await kiroProvider.listModels!({
      apiKey: "test-api-key-long",
    });

    expect(models).toContain("auto");
    expect(models).not.toContain("auto-thinking");
    expect(models).toContain("claude-sonnet-4.5");
    expect(models).toContain("claude-sonnet-4.5-thinking");
    expect(models).toContain("claude-sonnet-4.5-agentic");
    expect(models).toContain("claude-sonnet-4.5-thinking-agentic");
    expect(models).toContain("glm-5");
    expect(models).toContain("glm-5-thinking-agentic");
  });

  it("falls back to the real current catalog when discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const models = await kiroProvider.listModels!({ apiKey: "key-that-fails" });

    expect(models).toContain("auto");
    expect(models).toContain("claude-sonnet-4.5");
    expect(models).toContain("deepseek-3.2");
    expect(models).toContain("qwen3-coder-next");
    expect(models).not.toContain("claude-opus-5");
    expect(models).toEqual([...kiroFallbackModels]);
  });

  it("fetches live account quota via GetUsageLimits", async () => {
    let captured: { url: string; target: string; body: Record<string, unknown> } | undefined;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      captured = {
        url: String(input),
        target: String(
          new Headers(init?.headers).get("x-amz-target") ?? "",
        ),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          nextDateReset: 1790812800,
          subscriptionInfo: {
            subscriptionTitle: "KIRO FREE",
            type: "Q_DEVELOPER_STANDALONE_FREE",
          },
          usageBreakdownList: [
            {
              resourceType: "CREDIT",
              displayName: "Credit",
              displayNamePlural: "Credits",
              currentUsageWithPrecision: 0.15,
              usageLimitWithPrecision: 50,
              overageRate: 0.04,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = encodeKiroKey({
      accessToken: "token-abc",
      authMethod: "builder-id",
    });

    const quota = await fetchKiroUsageLimits({ apiKey: cred });

    expect(captured?.target).toBe(
      "AmazonCodeWhispererService.GetUsageLimits",
    );
    expect(captured?.body.origin).toBe("AI_EDITOR");
    expect(captured?.body.resourceType).toBe("AGENTIC_REQUEST");
    expect(quota.subscriptionTitle).toBe("KIRO FREE");
    expect(quota.nextDateReset).toBe(1790812800);
    expect(quota.breakdowns).toHaveLength(1);
    expect(quota.breakdowns[0]).toMatchObject({
      resourceType: "CREDIT",
      currentUsage: 0.15,
      usageLimit: 50,
    });
  });

  it("formats the kiro quota section for /usage", () => {
    const free = formatKiroQuotaSection({
      subscriptionTitle: "KIRO FREE",
      nextDateReset: 1790812800,
      breakdowns: [
        {
          resourceType: "CREDIT",
          displayNamePlural: "Credits",
          currentUsage: 12.5,
          usageLimit: 50,
          currentOverages: 0,
        },
      ],
    });
    expect(free).toContain("KIRO FREE");
    expect(free).toContain("12.5 / 50");
    expect(free).toContain("(25.0% used)");
    expect(free).toContain("37.5 remaining");
    expect(free).toContain("next reset:");
    expect(free).toContain("Kiro AI balance");

    expect(formatKiroQuotaSection("loading")).toContain("fetching live balance");
    expect(formatKiroQuotaSection("unavailable")).toContain("balance unavailable");
  });

  it("streams responses with AWS EventStream parsing and handles thinking and tokens", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: "Hello! <thinking>Analyzing request...</thinking>Let's write code." },
    );
    const frame2 = encodeFrame(
      { ":event-type": "metricsEvent" },
      {
        inputTokens: 42,
        outputTokens: 28,
        cachedTokens: 10,
        usage: 0.003005,
        unit: "credit",
        unitPlural: "credits",
      },
    );
    const frame3 = encodeFrame(
      { ":event-type": "messageStopEvent" },
      { stopReason: "stop" },
    );

    const fetchMock = vi.fn(async () => createStreamResponse([frame1, frame2, frame3]));
    vi.stubGlobal("fetch", fetchMock);

    const tokens: string[] = [];
    const statuses: string[] = [];
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
      (message) => statuses.push(message),
    );

    expect(tokens.join("")).toBe("Hello! Let's write code.");
    expect(result.text).toBe("Hello! Let's write code.");
    expect(result.reasoningBlock?.text).toBe("Analyzing request...");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toMatchObject({
      promptTokens: 42,
      completionTokens: 28,
      cachedPromptTokens: 10,
      charges: [{ amount: 0.003005, unit: "credits" }],
    });
    expect(statuses.some((message) => message.includes("charged"))).toBe(false);
  });

  it("streams reasoning deltas live for thinking tags and reasoningContentEvent", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: "Hello! <thinking>step one" },
    );
    const frame2 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: " step two</thinking>visible" },
    );
    const frame3 = encodeFrame(
      { ":event-type": "reasoningContentEvent" },
      { content: "extra reasoning" },
    );
    const frame4 = encodeFrame(
      { ":event-type": "messageStopEvent" },
      { stopReason: "stop" },
    );
    vi.stubGlobal("fetch", vi.fn(async () => createStreamResponse([frame1, frame2, frame3, frame4])));

    const events: Array<{ type: string; text?: string }> = [];
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });
    const result = await kiroProvider.stream!(
      {
        model: "claude-sonnet-4.5-thinking",
        messages: [{ role: "user", content: "hi" }],
        onStreamEvent: (event) => events.push(event),
      },
      { apiKey: cred },
      () => {},
    );

    const reasoningDeltas = events
      .filter((e) => e.type === "reasoning_delta")
      .map((e) => e.text);
    expect(reasoningDeltas).toEqual(["step one", " step two", "extra reasoning"]);
    expect(result.reasoningBlock?.text).toBe("step one step twoextra reasoning");
    expect(result.text).toBe("Hello! visible");
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

  it("sends the required chatTriggerType/origin fields in the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frame = encodeFrame(
        { ":event-type": "assistantResponseEvent" },
        { content: "ok" },
      );
      return createStreamResponse([frame]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cred = encodeKiroKey({
      accessToken: "token-abc",
      authMethod: "builder-id",
    });

    await kiroProvider.complete(
      {
        model: "claude-haiku-4.5",
        messages: [{ role: "user", content: "hello" }],
      },
      { apiKey: cred },
    );

    const convState = capturedBody?.conversationState as Record<string, unknown>;
    expect(convState?.chatTriggerType).toBe("MANUAL");
    const current = convState?.currentMessage as Record<string, unknown>;
    const uim = current?.userInputMessage as Record<string, unknown>;
    expect(uim?.origin).toBe("AI_EDITOR");
    expect(uim?.modelId).toBe("claude-haiku-4.5");
  });

  it("passes every effort through with a distinct budget (no collapse to high)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    }));
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });
    for (const effort of ["max", "xhigh", "high", "low"] as const) {
      await kiroProvider.complete(
        { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }], thinking: { enabled: true, effort } },
        { apiKey: cred },
      ).catch(() => {});
    }
    const budgets = bodies.map((b) => {
      const conv = b.conversationState as Record<string, unknown>;
      const cur = conv.currentMessage as Record<string, unknown>;
      const c = String((cur.userInputMessage as Record<string, unknown>).content ?? "");
      return /max_thinking_length>(\d+)</.exec(c)?.[1];
    });
    expect(budgets).toEqual(["64000", "32000", "16000", "4000"]);
    expect(new Set(budgets).size).toBe(4);
  });

  it("narrows the picker to the discovered vocabulary after preflight learning", async () => {
    const { registerWireRejectionEfforts, resetReasoningKnowledge } = await import("../src/llm/capabilities.js");
    const { reasoningOptionValues } = await import("../src/ui-core/commands/pickers/search-reasoning.js");
    resetReasoningKnowledge();
    registerWireRejectionEfforts("kiro", "claude-haiku-4.5", ["none", "low", "medium", "high"]);
    expect(reasoningOptionValues("kiro", "claude-haiku-4.5")).toEqual(["off", "low", "medium", "high"]);
    resetReasoningKnowledge();
  });

  it("discovers full per-model efforts via the ladder after a successful probe", async () => {
    const { runEffortPreflight, resetEffortPreflightForTesting } = await import(
      "../src/llm/wire/effort-preflight.js"
    );
    const { learnedRouteEfforts, resetReasoningKnowledge } = await import(
      "../src/llm/capabilities.js"
    );
    resetEffortPreflightForTesting();
    resetReasoningKnowledge();

    const route = {
      providerId: "kiro" as const,
      model: "claude-sonnet-4.5",
      requested: "high" as const,
    };
    await runEffortPreflight(route, async () => "accepted");

    expect(learnedRouteEfforts("kiro", "claude-sonnet-4.5")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    resetEffortPreflightForTesting();
    resetReasoningKnowledge();
  });

  it("uses the effort preflight ladder to discover per-model efforts", async () => {
    expect(
      needsEffortPreflight({
        providerId: "kiro",
        model: "claude-sonnet-4.5-thinking",
        requested: "high",
      }),
    ).toBe(true);
    expect(
      needsEffortPreflight({
        providerId: "kiro",
        model: "claude-sonnet-4.5-thinking",
        requested: "high",
        purpose: "auxiliary",
      }),
    ).toBe(false);
  });

  it("sorts kiro models with auto first and claude before cheaper text models", async () => {
    const sorted = kiroProvider.sortModels!([
      "glm-5",
      "claude-sonnet-4.5",
      "auto",
      "qwen3-coder-next",
      "deepseek-3.2",
      "claude-haiku-4.5",
      "minimax-m2.5",
    ]);
    expect(sorted[0]).toBe("auto");
    expect(sorted.indexOf("claude-sonnet-4.5")).toBeLessThan(sorted.indexOf("glm-5"));
    expect(sorted.indexOf("claude-haiku-4.5")).toBeLessThan(sorted.indexOf("glm-5"));
    expect(sorted.indexOf("auto-thinking")).toBe(-1);
  });

  it("builds a stable system prefix across identical thinking configs", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return createStreamResponse([
        encodeFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    const sys = (b: Record<string, unknown>) => {
      const cs = b.conversationState as Record<string, unknown>;
      const cur = cs.currentMessage as Record<string, unknown>;
      return String((cur.userInputMessage as Record<string, unknown>).content);
    };

    await kiroProvider.complete(
      { model: "claude-sonnet-4.5-thinking", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] },
      { apiKey: cred },
    );
    await kiroProvider.complete(
      { model: "claude-sonnet-4.5", thinking: { enabled: true, effort: "high" }, messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] },
      { apiKey: cred },
    );
    expect(bodies).toHaveLength(2);
    expect(sys(bodies[0]!)).toBe(sys(bodies[1]!));
    expect(sys(bodies[0]!)).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(sys(bodies[0]!)).toContain("<max_thinking_length>16000</max_thinking_length>");
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
    expect(claude.additionalModelRequestFields).toBeUndefined();

    const gpt = bodies[1]!;
    const gptMsg = (gpt.conversationState as Record<string, unknown>)
      .currentMessage as Record<string, unknown>;
    expect(String((gptMsg.userInputMessage as Record<string, unknown>).content)).not.toContain(
      "thinking_mode",
    );
    expect(gpt.additionalModelRequestFields).toBeUndefined();

    const plain = bodies[2]!;
    expect(plain.additionalModelRequestFields).toBeUndefined();
  });

  it("retries without reasoning options when the wire rejects additionalModelRequestFields", async () => {
    const serverError =
      '{"message":"additionalModelRequestFields is not supported\nfor this model","reason":"REQUEST_BODY_INVALID"}';
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("additionalModelRequestFields" in body) {
        return new Response(serverError, { status: 400 });
      }
      return createStreamResponse([
        encodeFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    const { tryStreamOnce } = await import("../src/llm/routing/attempt-stream.js");
    const provider = getProvider("kiro")!;
    const result = await tryStreamOnce(
      provider,
      "kiro",
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: true, effort: "high" },
      },
      "claude-sonnet-4.5",
      { apiKey: cred },
      () => {},
      undefined,
      "initial",
      false,
    );
    expect(result.text).toBe("ok");
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies.every((b) => !("additionalModelRequestFields" in b))).toBe(true);
  });

  it("shows dynamic per-model reasoning efforts via the picker", async () => {
    const { publishRouteReasoningVocabulary } = await import("../src/llm/route-vocabulary.js");
    const { reasoningOptionValues } = await import("../src/ui-core/commands/pickers/search-reasoning.js");
    const { modelSupportsThinking, effectiveThinkingEffort, resetReasoningKnowledge } = await import("../src/llm/capabilities.js");

    resetReasoningKnowledge();
    for (const model of ["claude-sonnet-4.5", "gpt-6", "deepseek-3.2", "minimax-m3", "auto"]) {
      publishRouteReasoningVocabulary("kiro", model);
    }

    expect(reasoningOptionValues("kiro", "claude-sonnet-4.5")).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningOptionValues("kiro", "gpt-6")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningOptionValues("kiro", "minimax-m3")).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(reasoningOptionValues("kiro", "deepseek-3.2")).toEqual(["off"]);
    expect(reasoningOptionValues("kiro", "auto")).toEqual(["off"]);

    expect(modelSupportsThinking("kiro", "claude-opus-5")).toBe(true);
    expect(effectiveThinkingEffort("kiro", "claude-sonnet-4.5", { enabled: true, effort: "high" })).toBe("high");
    expect(effectiveThinkingEffort("kiro", "deepseek-3.2", { enabled: true, effort: "high" })).toBeUndefined();
  });

  it("keeps history prefix stable when thinking toggles between turns", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          new ReadableStream({ start(c) { c.close(); } }),
          { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
        );
      }),
    );
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });

    await kiroProvider.stream(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "hi" },
        ],
        thinking: { enabled: true, effort: "high" },
      },
      { apiKey: cred },
      () => {},
    ).catch(() => {});
    await kiroProvider.stream(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello there" },
          { role: "user", content: "next" },
        ],
      },
      { apiKey: cred },
      () => {},
    ).catch(() => {});

    expect(bodies).toHaveLength(2);
    const currentOf = (b: Record<string, unknown>) => {
      const conv = b.conversationState as Record<string, unknown>;
      const cur = conv.currentMessage as Record<string, unknown>;
      return String((cur.userInputMessage as Record<string, unknown>).content ?? "");
    };
    const firstHistoryOf = (b: Record<string, unknown>) => {
      const conv = b.conversationState as Record<string, unknown>;
      const history = conv.history as Array<Record<string, unknown>>;
      return String((history[0]?.userInputMessage as Record<string, unknown> | undefined)?.content ?? "");
    };
    const asCurrent = currentOf(bodies[0]!);
    const asHistory = firstHistoryOf(bodies[1]!);
    expect(asCurrent).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(asHistory).not.toContain("thinking_mode");
    expect(asHistory).toBe(
      asCurrent.replace(/<thinking_mode>enabled<\/thinking_mode><max_thinking_length>\d+<\/max_thinking_length>\n\n/, ""),
    );
  });

  it("keeps history byte-identical across effort and model-suffix changes", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          new ReadableStream({ start(c) { c.close(); } }),
          { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
        );
      }),
    );
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });
    const base = [
      { role: "system" as const, content: "S" },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "A1" },
      { role: "user" as const, content: "next" },
    ];
    await kiroProvider.stream(
      { model: "claude-sonnet-4.5-thinking", messages: base },
      { apiKey: cred },
      () => {},
    ).catch(() => {});
    await kiroProvider.stream(
      { model: "claude-sonnet-4.5", messages: base, thinking: { enabled: true, effort: "low" } },
      { apiKey: cred },
      () => {},
    ).catch(() => {});
    expect(bodies).toHaveLength(2);
    const historyOf = (b: Record<string, unknown>) =>
      JSON.stringify((b.conversationState as Record<string, unknown>).history);
    expect(historyOf(bodies[1]!)).toBe(historyOf(bodies[0]!));
  });

  it("sends clean requests for paid-tier new model families and free-tier text models", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return createStreamResponse([
          encodeFrame({ ":event-type": "assistantResponseEvent" }, { content: "ok" }),
        ]);
      }),
    );
    const cred = encodeKiroKey({ accessToken: "tok", authMethod: "builder-id" });
    const cases: Array<[string, boolean]> = [
      ["gpt-6-thinking", false],
      ["deepseek-v4", false],
      ["minimax-m3", false],
      ["glm-5", false],
      ["deepseek-3.2", false],
      ["minimax-m2.5", false],
    ];
    for (const [model] of cases) {
      await kiroProvider.complete(
        {
          model,
          messages: [{ role: "user", content: "hi" }],
          thinking: { enabled: true, effort: "high" },
        },
        { apiKey: cred },
      );
    }
    expect(bodies).toHaveLength(cases.length);
    const contentOf = (b: Record<string, unknown>) => {
      const conv = b.conversationState as Record<string, unknown>;
      const cur = conv.currentMessage as Record<string, unknown>;
      return String((cur.userInputMessage as Record<string, unknown>).content ?? "");
    };
    for (let i = 0; i < cases.length; i++) {
      const [, expectDirective] = cases[i]!;
      const body = bodies[i]!;
      expect("additionalModelRequestFields" in body).toBe(false);
      if (expectDirective) {
        expect(contentOf(body)).toContain("<thinking_mode>enabled</thinking_mode>");
      } else {
        expect(contentOf(body)).not.toContain("thinking_mode");
      }
    }
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

  it("merges split cache metrics across metricsEvent and meteringEvent frames", async () => {
    const frame1 = encodeFrame(
      { ":event-type": "assistantResponseEvent" },
      { content: "cached" },
    );
    const frame2 = encodeFrame(
      { ":event-type": "metricsEvent" },
      { inputTokens: 1000, outputTokens: 50, cachedTokens: 500 },
    );
    const frame3 = encodeFrame(
      { ":event-type": "meteringEvent" },
      { cacheReadInputTokens: 700, cacheWriteInputTokens: 200 },
    );
    const fetchMock = vi.fn(async () => createStreamResponse([frame1, frame2, frame3]));
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
      cacheCreationTokens: 200,
      uncachedPromptTokens: 300,
      exact: true,
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
