import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletionRequest, ProviderId } from "../../src/types.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import { OperationUsageRecorder } from "../../src/llm/operation-usage.js";
import { installTransport, type FakeTransport } from "../conformance/fake-transport.js";
import { buildWireResponse } from "../conformance/wire-fixtures.js";
import {
  admittedHosts,
  admittedKeys,
  authRejected,
  chatCompletion,
  contextTooLarge,
  disabledSlots,
  imageInputUnsupported,
  keySlots,
  metaBudgetIncomplete,
  modelNotFound,
  quotaExhausted,
  rateLimitedWithoutBackoff,
  reasoningControlUnsupported,
  response,
  toolsUnsupported,
  userTurn,
} from "./admission-fixtures.js";

let slotsByProvider: Partial<Record<ProviderId, ProviderKeySlot[]>> = {};
let activeIndexByProvider: Partial<Record<ProviderId, number>> = {};
let providerFallback = true;

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => ({
      keys: slotsByProvider[provider] ?? [],
      activeIndex: activeIndexByProvider[provider] ?? 0,
      source: "storage" as const,
    }),
    getProviderSecret: async (provider: ProviderId) => ({
      value: slotsByProvider[provider]?.[0]?.value ?? "",
      source: "storage" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "nvidia",
      providerFallback,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
    getActiveProviderEndpoint: () => "",
    setActiveProviderEndpoint: () => undefined,
    setDefaultProvider: () => undefined,
    setProviderModel: () => undefined,
  };
});

const { completeWithProvider, providers, streamWithProvider } = await import("../../src/llm/router.js");

const NVIDIA_MODEL = providers.nvidia.defaultModel;
const META_MODEL = providers.meta.defaultModel;
const REASONING_CONTROL_MODEL = "moonshotai/kimi-k2-thinking";

function installScript(...steps: Array<() => Response>): FakeTransport {
  let index = 0;
  return installTransport(() => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return step();
  });
}

function metaSseBudgetIncomplete(): Response {
  const frames = [
    { type: "response.created", response: { id: "resp_admission" } },
    {
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 12, output_tokens: 64, total_tokens: 76 },
      },
    },
  ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function stalledJsonResponse(onBodyRead: () => void): Response {
  let notified = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        if (!notified) {
          notified = true;
          onBodyRead();
        }
        return new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function turn(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return { provider: "nvidia", messages: userTurn(), ...overrides };
}

beforeEach(() => {
  slotsByProvider = {};
  activeIndexByProvider = {};
  providerFallback = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("key rotation admissions", () => {
  it("issues exactly one admission for a single key with maxRetries 0", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(1);
  });

  it("issues seven admissions for a single key on the default retry budget", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(completeWithProvider(turn())).rejects.toThrow();

    expect(transport.generations).toHaveLength(7);
    expect(new Set(admittedKeys(transport))).toEqual(new Set(["nvapi-a"]));
  });

  it("issues four admissions for two keys even with maxRetries 0", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
    };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(4);
    expect(admittedKeys(transport)).toEqual([
      "nvapi-a",
      "nvapi-a",
      "nvapi-b",
      "nvapi-b",
    ]);
    expect(admittedHosts(transport).every((host) => host.includes("nvidia"))).toBe(
      true,
    );
  });

  it("admits each key exactly once on a per-key quota failure", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a", "nvapi-b", "nvapi-c"]) };
    const transport = installScript(quotaExhausted);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(3);
    expect(admittedKeys(transport)).toEqual(["nvapi-a", "nvapi-b", "nvapi-c"]);
  });

  it("starts rotation at the sticky active key and wraps circularly", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a", "nvapi-b", "nvapi-c"]) };
    activeIndexByProvider = { nvidia: 1 };
    const transport = installScript(authRejected);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(admittedKeys(transport)).toEqual(["nvapi-b", "nvapi-c", "nvapi-a"]);
  });

  it("admits once on a key-circle stop error even with three keys", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a", "nvapi-b", "nvapi-c"]) };
    const transport = installScript(modelNotFound);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(1);
  });

  it("fails locally with zero admissions when every key is disabled", async () => {
    slotsByProvider = { nvidia: disabledSlots(["nvapi-a", "nvapi-b"]) };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(0);
  });
});

describe("cross-provider fallback admissions", () => {
  it("admits once per keyed provider when every route rejects the input size", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
      openai: keySlots(["sk-y"]),
    };
    const transport = installScript(contextTooLarge);

    await expect(
      completeWithProvider(turn({ model: undefined }), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(3);
    expect(admittedHosts(transport)).toEqual([
      "integrate.api.nvidia.com",
      "openrouter.ai",
      "api.openai.com",
    ]);
  });

  it("keeps a rate-limited turn on the requested provider", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
    };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(admittedHosts(transport)).toEqual([
      "integrate.api.nvidia.com",
      "integrate.api.nvidia.com",
      "integrate.api.nvidia.com",
      "integrate.api.nvidia.com",
    ]);
  });

  it("disables fallback entirely when exactly one key is configured", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]), openrouter: keySlots(["sk-or-x"]) };
    const transport = installScript(contextTooLarge);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(1);
  });

  it("admits only the requested provider when fallback is off in config", async () => {
    providerFallback = false;
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
    };
    const transport = installScript(contextTooLarge);

    await expect(
      completeWithProvider(turn(), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(1);
  });
});

describe("in-place route adaptation admissions", () => {
  it("spends a second admission on a tools rejection", async () => {
    const model = "admission/tools-downgrade";
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(toolsUnsupported, () =>
      chatCompletion("downgraded answer", model),
    );

    const result = await completeWithProvider(
      turn({
        model,
        tools: [
          {
            name: "fs.read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
        toolChoice: "auto",
      }),
      { maxRetries: 0 },
    );

    expect(result.text).toContain("downgraded answer");
    expect(transport.generations).toHaveLength(2);
    expect((transport.generations[0]!.body as { tools?: unknown }).tools).toBeDefined();
    expect(
      (transport.generations[1]!.body as { tools?: unknown }).tools,
    ).toBeUndefined();
  });

  it("spends a second admission on a reasoning-control rejection", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(reasoningControlUnsupported, () =>
      chatCompletion("answer without reasoning control", REASONING_CONTROL_MODEL),
    );

    await completeWithProvider(
      turn({
        model: REASONING_CONTROL_MODEL,
        thinking: { enabled: true, effort: "high" },
      }),
      { maxRetries: 0 },
    );

    expect(transport.generations).toHaveLength(2);
    const first = transport.generations[0]!.body as Record<string, unknown>;
    const second = transport.generations[1]!.body as Record<string, unknown>;
    expect(first.chat_template_kwargs).toEqual({ thinking: true });
    // "high" has no lower fallback in the simplified ladder, so the second
    // admission strips reasoning entirely.
    expect(second.chat_template_kwargs).toBeUndefined();
  });

  it("spends a second admission on an image-input rejection", async () => {
    const model = "admission/image-downgrade";
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(imageInputUnsupported, () =>
      chatCompletion("answer without images", model),
    );

    await completeWithProvider(
      turn({
        model,
        messages: [
          {
            role: "user",
            content: "describe the attachment",
            images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
          },
        ],
      }),
      { maxRetries: 0 },
    );

    expect(transport.generations).toHaveLength(2);
    expect(JSON.stringify(transport.generations[0]!.body)).toContain("image_url");
    expect(JSON.stringify(transport.generations[1]!.body)).not.toContain("image_url");
  });
});

describe("Meta output-budget admissions", () => {
  it("surfaces one incomplete admission instead of hiding recursive retries", async () => {
    slotsByProvider = { meta: keySlots(["meta-a"]) };
    const transport = installScript(() => metaBudgetIncomplete(META_MODEL));

    const result = await completeWithProvider(
      { provider: "meta", messages: userTurn() },
      { maxRetries: 0 },
    );

    expect(transport.generations).toHaveLength(1);
    expect(
      transport.generations.map(
        (request) =>
          (request.body as { max_output_tokens?: number }).max_output_tokens,
      ),
    ).toEqual([4096]);
    expect(result.finishReason).toBe("length");
  });

  it("retains usage from the surfaced incomplete admission", async () => {
    slotsByProvider = { meta: keySlots(["meta-a"]) };
    installScript(() => metaBudgetIncomplete(META_MODEL));

    const result = await completeWithProvider(
      { provider: "meta", messages: userTurn() },
      { maxRetries: 0 },
    );

    expect(result.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 64,
      totalTokens: 76,
    });
    expect(result.operationUsage?.attempts).toHaveLength(1);
  });
});

describe("operation attempt usage", () => {
  it("records one known successful admission without double counting", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installScript(() => chatCompletion("recorded answer", NVIDIA_MODEL));
    const snapshots: unknown[] = [];

    const result = await completeWithProvider(turn(), {
      maxRetries: 0,
      onOperationUsage: (snapshot) => snapshots.push(snapshot),
    });

    const snapshot = result.operationUsage!;
    expect(snapshots).toEqual([snapshot]);
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.attempts[0]).toMatchObject({
      provider: "nvidia",
      mode: "complete",
      reason: "initial",
      outcome: "success",
      usage: { kind: "known" },
    });
    expect(snapshot.aggregate).toMatchObject({
      status: "known",
      knownAdmissions: 1,
      unknownAdmissions: 0,
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
  });

  it("distinguishes the initial failure from same-route retries", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installScript(rateLimitedWithoutBackoff);
    const recorder = new OperationUsageRecorder();

    await expect(
      completeWithProvider(turn(), { attemptUsage: recorder }),
    ).rejects.toThrow();

    const snapshot = recorder.snapshot();
    expect(snapshot.attempts).toHaveLength(7);
    expect(snapshot.attempts.map((attempt) => attempt.reason)).toEqual([
      "initial",
      "retry",
      "retry",
      "retry",
      "retry",
      "retry",
      "retry",
    ]);
    expect(snapshot.attempts.every((attempt) => attempt.outcome === "failure")).toBe(
      true,
    );
    expect(snapshot.aggregate).toEqual({
      status: "unknown",
      knownAdmissions: 0,
      unknownAdmissions: 7,
    });
  });

  it("marks cross-provider admissions as fallback", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
      openai: keySlots(["sk-y"]),
    };
    installScript(contextTooLarge);
    const recorder = new OperationUsageRecorder();

    await expect(
      completeWithProvider(turn({ model: undefined }), {
        maxRetries: 0,
        attemptUsage: recorder,
      }),
    ).rejects.toThrow();

    expect(
      recorder.snapshot().attempts.map(({ provider, reason, outcome }) => ({
        provider,
        reason,
        outcome,
      })),
    ).toEqual([
      { provider: "nvidia", reason: "initial", outcome: "failure" },
      { provider: "openrouter", reason: "fallback", outcome: "failure" },
      { provider: "openai", reason: "fallback", outcome: "failure" },
    ]);
  });

  it("records rejected controls and their successful adaptation separately", async () => {
    const model = "admission/tools-usage";
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installScript(toolsUnsupported, () => chatCompletion("adapted", model));
    const recorder = new OperationUsageRecorder();

    await completeWithProvider(
      turn({
        model,
        tools: [
          {
            name: "fs.read",
            wireName: "fs_read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      }),
      { maxRetries: 0, attemptUsage: recorder },
    );

    const snapshot = recorder.snapshot();
    expect(snapshot.attempts.map((attempt) => attempt.reason)).toEqual([
      "initial",
      "adaptation",
    ]);
    expect(snapshot.attempts.map((attempt) => attempt.outcome)).toEqual([
      "failure",
      "success",
    ]);
    expect(snapshot.aggregate).toMatchObject({
      status: "partial",
      knownAdmissions: 1,
      unknownAdmissions: 1,
      usage: { totalTokens: 18 },
    });
  });

  it("does not synthesize missing optional usage buckets as zero", () => {
    const recorder = new OperationUsageRecorder();
    recorder
      .begin({ provider: "nvidia", model: NVIDIA_MODEL, mode: "complete", reason: "initial" })
      .complete("failure", {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        exact: true,
        cachedPromptTokens: 8,
        uncachedPromptTokens: 2,
        reasoningTokens: 1,
      });
    recorder
      .begin({ provider: "nvidia", model: NVIDIA_MODEL, mode: "complete", reason: "retry" })
      .complete("success", {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        exact: true,
      });

    const snapshot = recorder.snapshot();
    expect(snapshot.attempts[0]?.usage).toEqual({
      kind: "known",
      value: expect.objectContaining({
        cachedPromptTokens: 8,
        uncachedPromptTokens: 2,
        reasoningTokens: 1,
      }),
    });
    const aggregateUsage = snapshot.aggregate.usage;
    expect(aggregateUsage).toBeDefined();
    expect(aggregateUsage).not.toHaveProperty("cachedPromptTokens");
    expect(aggregateUsage).not.toHaveProperty("uncachedPromptTokens");
    expect(aggregateUsage).not.toHaveProperty("reasoningTokens");
  });

  it("distinguishes caller cancellation from an ordinary failure", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const controller = new AbortController();
    installTransport(() => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw controller.signal.reason;
    });
    const recorder = new OperationUsageRecorder();

    await expect(
      completeWithProvider(turn({ signal: controller.signal }), {
        maxRetries: 0,
        attemptUsage: recorder,
      }),
    ).rejects.toThrow();

    expect(recorder.snapshot().attempts).toMatchObject([
      { reason: "initial", outcome: "cancelled", usage: { kind: "unknown" } },
    ]);
  });

  it("keeps a provider transport AbortError classified as failure", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installTransport(() => {
      throw new DOMException("transport aborted", "AbortError");
    });

    const error = await completeWithProvider(turn(), { maxRetries: 0 }).catch(
      (caught: unknown) => caught,
    );
    const snapshot = (error as { operationUsage?: ReturnType<OperationUsageRecorder["snapshot"]> })
      .operationUsage;

    expect(snapshot?.attempts).toMatchObject([
      { reason: "initial", outcome: "failure", usage: { kind: "unknown" } },
    ]);
  });

  it("wraps primitive failure reasons with an accessible usage snapshot", async () => {
    const controller = new AbortController();
    controller.abort("primitive cancellation reason");

    const error = await completeWithProvider(
      turn({ signal: controller.signal }),
      { maxRetries: 0 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { cause?: unknown }).cause).toBe(
      "primitive cancellation reason",
    );
    expect(
      (error as { operationUsage?: ReturnType<OperationUsageRecorder["snapshot"]> })
        .operationUsage?.attempts,
    ).toEqual([]);
  });

  it("does not record local serialization failures as physical attempts", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(() =>
      chatCompletion("must not be requested", NVIDIA_MODEL),
    );
    const recorder = new OperationUsageRecorder();
    const request = turn({
      tools: [
        {
          name: "cyclic.tool",
          wireName: "cyclic_tool",
          description: "contains a cyclic schema",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const parameters = request.tools![0]!.parameters as Record<string, unknown>;
    parameters.self = parameters;

    const error = await completeWithProvider(request, {
      maxRetries: 0,
      attemptUsage: recorder,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(transport.generations).toHaveLength(0);
    expect(recorder.snapshot().attempts).toEqual([]);
    expect(
      (error as { operationUsage?: ReturnType<OperationUsageRecorder["snapshot"]> })
        .operationUsage?.attempts,
    ).toEqual([]);
  });

  for (const { provider, model } of [
    { provider: "nvidia" as const, model: NVIDIA_MODEL },
    { provider: "meta" as const, model: META_MODEL },
  ]) {
    it(`settles ${provider} JSON stream cancellation as one terminal attempt`, async () => {
      slotsByProvider = { [provider]: keySlots([`${provider}-key`]) };
      let notifyBodyRead!: () => void;
      const bodyReadStarted = new Promise<void>((resolve) => {
        notifyBodyRead = resolve;
      });
      const transport = installTransport(() => stalledJsonResponse(notifyBodyRead));
      const recorder = new OperationUsageRecorder();
      const controller = new AbortController();

      const pending = streamWithProvider(
        { provider, model, messages: userTurn(), signal: controller.signal },
        () => {},
        { maxRetries: 0, attemptUsage: recorder },
      );
      await bodyReadStarted;
      controller.abort(new DOMException("cancelled", "AbortError"));
      const error = await pending.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(transport.generations).toHaveLength(1);
      expect(recorder.snapshot().attempts).toMatchObject([
        {
          provider,
          mode: "stream",
          reason: "initial",
          outcome: "cancelled",
          usage: { kind: "unknown" },
        },
      ]);
      expect(
        (error as { operationUsage?: ReturnType<OperationUsageRecorder["snapshot"]> })
          .operationUsage?.attempts,
      ).toHaveLength(1);
    });
  }

  it("records each Bynara effort fallback as a physical admission", async () => {
    const model = providers.bynara.defaultModel;
    slotsByProvider = { bynara: keySlots(["bynara-key"]) };
    const transport = installScript(
      () => response({ error: { message: "reasoning_effort must be one of low, medium, high" } }, 400),
      () => chatCompletion("accepted effort", model),
    );
    const recorder = new OperationUsageRecorder();

    await completeWithProvider(
      {
        provider: "bynara",
        model,
        messages: userTurn(),
        thinking: { enabled: true, effort: "max" },
      },
      { maxRetries: 0, attemptUsage: recorder },
    );

    expect(transport.generations).toHaveLength(2);
    expect(recorder.snapshot().attempts).toMatchObject([
      { provider: "bynara", reason: "initial", outcome: "failure" },
      { provider: "bynara", reason: "provider-retry", outcome: "success" },
    ]);
  });

  it("records each AgentRouter client-identity rotation as a physical admission", async () => {
    const model = providers.agentrouter.defaultModel;
    slotsByProvider = { agentrouter: keySlots(["sk-agentrouter-test"]) };
    const transport = installScript(
      () => response({ error: { message: "unauthorized_client_error: unknown client detected" } }, 401),
      () => chatCompletion("authorized client", model),
    );
    const recorder = new OperationUsageRecorder();

    await completeWithProvider(
      { provider: "agentrouter", model, messages: userTurn() },
      { maxRetries: 0, attemptUsage: recorder },
    );

    expect(transport.generations).toHaveLength(2);
    expect(recorder.snapshot().attempts).toMatchObject([
      { provider: "agentrouter", reason: "initial", outcome: "failure" },
      { provider: "agentrouter", reason: "provider-retry", outcome: "success" },
    ]);
  });

  for (const mode of ["complete", "stream"] as const) {
    it(`records the AgentRouter ${mode} thinking-budget retry as a physical admission`, async () => {
      const model = providers.agentrouter.defaultModel;
      slotsByProvider = { agentrouter: keySlots(["sk-agentrouter-test"]) };
      const transport = installScript(
        () =>
          response(
            {
              error: {
                message:
                  "max_tokens must exceed thinking budget_tokens 16384",
              },
            },
            400,
          ),
        () => chatCompletion("raised output budget", model),
      );
      const recorder = new OperationUsageRecorder();
      const request = {
        provider: "agentrouter" as const,
        model,
        messages: userTurn(),
        maxTokens: 4_096,
        thinking: { enabled: true },
      };

      if (mode === "complete") {
        await completeWithProvider(request, {
          maxRetries: 0,
          attemptUsage: recorder,
        });
      } else {
        await streamWithProvider(request, () => {}, {
          maxRetries: 0,
          attemptUsage: recorder,
        });
      }

      expect(transport.generations).toHaveLength(2);
      expect(recorder.snapshot().attempts).toMatchObject([
        {
          provider: "agentrouter",
          mode,
          reason: "initial",
          outcome: "failure",
        },
        {
          provider: "agentrouter",
          mode,
          reason: "provider-retry",
          outcome: "success",
        },
      ]);
    });
  }

  for (const { label, responseFactory } of [
    {
      label: "JSON",
      responseFactory: () => metaBudgetIncomplete(META_MODEL),
    },
    { label: "SSE", responseFactory: metaSseBudgetIncomplete },
  ]) {
    it(`surfaces one Meta ${label} stream budget stop as one admission`, async () => {
      slotsByProvider = { meta: keySlots(["meta-a"]) };
      const transport = installScript(responseFactory);
      const recorder = new OperationUsageRecorder();

      const result = await streamWithProvider(
        { provider: "meta", messages: userTurn() },
        () => {},
        { maxRetries: 0, attemptUsage: recorder },
      );

      expect(result.finishReason).toBe("length");
      expect(transport.generations).toHaveLength(1);
      expect(recorder.snapshot().attempts).toMatchObject([
        {
          provider: "meta",
          mode: "stream",
          reason: "initial",
          outcome: "success",
          usage: { kind: "known" },
        },
      ]);
    });
  }

  it("keeps Meta transient stream fetches and records one-to-one on exhaustion", async () => {
    vi.useFakeTimers();
    try {
      slotsByProvider = { meta: keySlots(["meta-a"]) };
      const transport = installTransport(() => {
        throw new Error("fetch failed");
      });
      const recorder = new OperationUsageRecorder();
      const rejected = expect(
        streamWithProvider(
          { provider: "meta", messages: userTurn() },
          () => {},
          { maxRetries: 0, attemptUsage: recorder },
        ),
      ).rejects.toThrow(/fetch failed/i);

      await vi.runAllTimersAsync();
      await rejected;

      expect(transport.generations).toHaveLength(2);
      expect(recorder.snapshot().attempts).toMatchObject([
        { reason: "initial", outcome: "failure" },
        { reason: "provider-retry", outcome: "failure" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not record a Meta retry cancelled during backoff before fetch", async () => {
    vi.useFakeTimers();
    try {
      slotsByProvider = { meta: keySlots(["meta-a"]) };
      const controller = new AbortController();
      const transport = installTransport(() => {
        queueMicrotask(() => controller.abort("cancelled during backoff"));
        throw new Error("fetch failed");
      });
      const recorder = new OperationUsageRecorder();
      const rejected = expect(
        streamWithProvider(
          { provider: "meta", messages: userTurn(), signal: controller.signal },
          () => {},
          { maxRetries: 0, attemptUsage: recorder },
        ),
      ).rejects.toThrow();

      await vi.runAllTimersAsync();
      await rejected;

      expect(transport.generations).toHaveLength(1);
      expect(recorder.snapshot().attempts).toMatchObject([
        { reason: "initial", outcome: "cancelled" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transport isolation", () => {
  it("routes every admission through the stubbed transport", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installTransport(() => {
      throw new Error("live network blocked");
    });

    await expect(
      completeWithProvider(turn({ model: NVIDIA_MODEL }), { maxRetries: 0 }),
    ).rejects.toThrow();

    expect(transport.generations).toHaveLength(1);
  });
});
