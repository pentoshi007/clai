import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletionRequest, ProviderId } from "../../src/types.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import { installTransport, type FakeTransport } from "../conformance/fake-transport.js";
import {
  chatCompletion,
  contextTooLarge,
  keySlots,
  metaBudgetIncomplete,
  rateLimitedWithoutBackoff,
  toolsUnsupported,
  userTurn,
} from "./admission-fixtures.js";

let slotsByProvider: Partial<Record<ProviderId, ProviderKeySlot[]>> = {};
let defaultProviderWrites: string[] = [];
let providerModelWrites: Array<[string, string]> = [];

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => ({
      keys: slotsByProvider[provider] ?? [],
      activeIndex: 0,
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
      providerFallback: true,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
    getActiveProviderEndpoint: () => "",
    setActiveProviderEndpoint: () => undefined,
    setDefaultProvider: (id: string) => {
      defaultProviderWrites.push(id);
    },
    setProviderModel: (id: string, model: string) => {
      providerModelWrites.push([id, model]);
    },
  };
});

const { completeWithProvider, providers, streamWithProvider } = await import("../../src/llm/router.js");
const {
  OperationAdmissionBudgetExceededError,
  OperationLedger,
  OperationSemanticOutputError,
  singleAdmissionOperationPolicy,
} = await import("../../src/llm/operation-ledger.js");
const { OperationUsageRecorder } = await import("../../src/llm/operation-usage.js");

const NVIDIA_MODEL = providers.nvidia.defaultModel;
const META_MODEL = providers.meta.defaultModel;

function installScript(...steps: Array<() => Response>): FakeTransport {
  let index = 0;
  return installTransport(() => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return step();
  });
}

function metaSseReasoningThenBudgetIncomplete(): Response {
  const frames = [
    { type: "response.created", response: { id: "resp_ledger" } },
    { type: "response.reasoning_summary_text.delta", delta: "planning the visible answer" },
    {
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
      },
    },
  ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function turn(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return { provider: "nvidia", messages: userTurn(), ...overrides };
}

beforeEach(() => {
  slotsByProvider = {};
  defaultProviderWrites = [];
  providerModelWrites = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("single-admission operation policy", () => {
  it("caps key rotation at one generation HTTP request", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a", "nvapi-b"]) };
    const transport = installScript(rateLimitedWithoutBackoff);
    const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));

    // The budget stops the second dispatch, but the caller must see the failure
    // that actually happened rather than the guard that refused the retry.
    await expect(
      completeWithProvider(turn(), { maxRetries: 0, operation: ledger }),
    ).rejects.not.toBeInstanceOf(OperationAdmissionBudgetExceededError);

    expect(transport.generations).toHaveLength(1);
    expect(ledger.admissionsUsed).toBe(1);
    expect(ledger.admissionRefused).toBe(true);
    expect(ledger.terminalOutcome).toBe("budget-exceeded");
    expect(ledger.snapshot().attempts).toHaveLength(1);
    expect(ledger.snapshot().attempts[0]).toMatchObject({
      outcome: "failure",
      reason: "initial",
    });
  });

  it("caps cross-provider fallback at one generation HTTP request", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
      openai: keySlots(["sk-y"]),
    };
    const transport = installScript(contextTooLarge);
    const ledger = new OperationLedger(
      singleAdmissionOperationPolicy("compaction"),
    );

    // Fallback cannot spend a second admission, and the surfaced error names the
    // provider limit the user can act on instead of the internal guard.
    await expect(
      completeWithProvider(turn({ model: undefined }), {
        maxRetries: 0,
        operation: ledger,
      }),
    ).rejects.not.toBeInstanceOf(OperationAdmissionBudgetExceededError);

    expect(transport.generations).toHaveLength(1);
  });

  it("pins the route so a single-dispatch operation never reaches the guard", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
      openai: keySlots(["sk-y"]),
    };
    const transport = installScript(rateLimitedWithoutBackoff);
    const ledger = new OperationLedger(
      singleAdmissionOperationPolicy("compaction"),
    );

    await expect(
      completeWithProvider(turn(), {
        maxRetries: 0,
        singleDispatch: true,
        operation: ledger,
      }),
    ).rejects.not.toBeInstanceOf(OperationAdmissionBudgetExceededError);

    expect(transport.generations).toHaveLength(1);
    expect(ledger.admissionsUsed).toBe(1);
    expect(ledger.admissionRefused).toBe(false);
    expect(ledger.terminalOutcome).toBe("failed");
  });

  it("caps in-place capability adaptation at one generation HTTP request", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(
      toolsUnsupported,
      () => chatCompletion("downgraded answer", NVIDIA_MODEL),
    );

    await expect(
      completeWithProvider(
        turn({
          model: "admission/ledger-tools-downgrade",
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
        }),
        {
          maxRetries: 0,
          operation: new OperationLedger(
            singleAdmissionOperationPolicy("compaction"),
          ),
        },
      ),
    ).rejects.toBeInstanceOf(OperationAdmissionBudgetExceededError);

    expect(transport.generations).toHaveLength(1);
  });

  it("surfaces Meta output exhaustion within one generation HTTP request", async () => {
    slotsByProvider = { meta: keySlots(["meta-a"]) };
    const transport = installScript(() => metaBudgetIncomplete(META_MODEL));
    const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));

    const result = await completeWithProvider(
      { provider: "meta", messages: userTurn() },
      { maxRetries: 0, operation: ledger },
    );

    expect(result.finishReason).toBe("length");
    expect(transport.generations).toHaveLength(1);
    expect(ledger.snapshot().attempts).toHaveLength(1);
    expect(ledger.snapshot().attempts[0]).toMatchObject({
      provider: "meta",
      reason: "initial",
      outcome: "success",
    });
    expect(ledger.snapshot().aggregate.usage).toMatchObject({
      promptTokens: 12,
      completionTokens: 64,
      totalTokens: 76,
    });
  });
});

describe("semantic output policy", () => {
  it("returns Meta budget exhaustion after streamed reasoning without regenerating", async () => {
    slotsByProvider = { meta: keySlots(["meta-a"]) };
    const transport = installTransport(() =>
      metaSseReasoningThenBudgetIncomplete(),
    );
    const ledger = new OperationLedger();

    const tokens: string[] = [];
    const reasoningDeltas: string[] = [];
    const result = await streamWithProvider(
      { provider: "meta", messages: userTurn() },
      (token) => tokens.push(token),
      {
        maxRetries: 0,
        operation: ledger,
        onStreamEvent: (event) => {
          if (event.type === "reasoning_delta") {
            reasoningDeltas.push(event.text);
          }
        },
      },
    );

    expect(result.finishReason).toBe("length");
    expect(transport.generations).toHaveLength(1);
    const joined = reasoningDeltas.join("");
    expect(joined).toContain("planning the visible answer");
    expect(joined.split("planning the visible answer").length - 1).toBe(1);
    expect(tokens.join("")).toBe("");
    expect(ledger.semanticOutputPublished).toBe(true);
    expect(ledger.snapshot().attempts).toHaveLength(1);
    expect(ledger.snapshot().attempts[0]).toMatchObject({
      outcome: "success",
      usage: { kind: "known" },
    });
  });

  it("denies transparent retry admissions after published semantic output", () => {
    const ledger = new OperationLedger();
    ledger
      .begin({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        mode: "complete",
        reason: "initial",
      })
      .complete("success");
    ledger.noteSemanticOutput();

    expect(() =>
      ledger.begin({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        mode: "complete",
        reason: "provider-retry",
      }),
    ).toThrow(OperationSemanticOutputError);
    expect(() =>
      ledger.begin({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        mode: "complete",
        reason: "retry",
      }),
    ).toThrow(OperationSemanticOutputError);

    ledger
      .begin({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        mode: "complete",
        reason: "initial",
      })
      .complete("success");
    expect(ledger.snapshot().attempts).toHaveLength(2);
  });
});

describe("fallback adoption policy", () => {
  it("keeps a successful fallback session-local by default", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
    };
    installTransport((request) =>
      new URL(request.url).host.includes("nvidia")
        ? contextTooLarge()
        : chatCompletion("fallback answer", providers.openrouter.defaultModel),
    );

    const result = await completeWithProvider(turn({ model: undefined }), {
      maxRetries: 0,
    });

    expect(result.provider).toBe("openrouter");
    expect(defaultProviderWrites).toEqual([]);
    expect(providerModelWrites).toEqual([]);
  });

  it("persists the fallback route only when adoption is explicit", async () => {
    slotsByProvider = {
      nvidia: keySlots(["nvapi-a", "nvapi-b"]),
      openrouter: keySlots(["sk-or-x"]),
    };
    installTransport((request) =>
      new URL(request.url).host.includes("nvidia")
        ? contextTooLarge()
        : chatCompletion("fallback answer", providers.openrouter.defaultModel),
    );

    const result = await completeWithProvider(turn({ model: undefined }), {
      maxRetries: 0,
      adoptFallback: true,
    });

    expect(result.provider).toBe("openrouter");
    expect(defaultProviderWrites).toEqual(["openrouter"]);
    expect(providerModelWrites).toEqual([
      ["openrouter", providers.openrouter.defaultModel],
    ]);
  });
});

describe("ledger budget mechanics", () => {
  it("keeps the documented default rotation under the default turn policy", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(rateLimitedWithoutBackoff);

    await expect(completeWithProvider(turn())).rejects.toThrow();

    expect(transport.generations).toHaveLength(7);
  });

  it("counts explicit continuations separately from admissions", () => {
    const ledger = new OperationLedger({
      kind: "turn",
      admissionBudget: 1,
      continuationBudget: 1,
    });
    const handle = ledger.begin({
      provider: "nvidia",
      model: NVIDIA_MODEL,
      mode: "complete",
      reason: "initial",
    });
    handle.complete("success", {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      exact: true,
    });

    expect(() =>
      ledger.begin({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        mode: "complete",
        reason: "retry",
      }),
    ).toThrow(OperationAdmissionBudgetExceededError);

    ledger.beginContinuation();
    expect(ledger.continuationsUsed).toBe(1);

    const continuation = ledger.begin({
      provider: "nvidia",
      model: NVIDIA_MODEL,
      mode: "complete",
      reason: "initial",
    });
    continuation.complete("success");
    expect(() => ledger.beginContinuation()).toThrow(
      OperationAdmissionBudgetExceededError,
    );
    expect(ledger.snapshot().attempts).toHaveLength(2);
  });

  it("records into a caller-supplied recorder under the ledger budget", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installScript(() => chatCompletion("recorded answer", NVIDIA_MODEL));
    const recorder = new OperationUsageRecorder();

    const result = await completeWithProvider(turn(), {
      maxRetries: 0,
      attemptUsage: recorder,
    });

    expect(result.text).toBe("recorded answer");
    expect(recorder.snapshot().attempts).toHaveLength(1);
    expect(result.operationUsage).toEqual(recorder.snapshot());
  });
});
