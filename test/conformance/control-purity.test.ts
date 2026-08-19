import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import { chatCompletionsBodyFromPlan } from "../../src/llm/http.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { providers } from "../../src/llm/router.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import type {
  CompletionRequestPurpose,
  GenerationAttemptReason,
  ProviderId,
  ReasoningEffort,
} from "../../src/types.js";
import { CONFORMANCE_ROUTES } from "./routes.js";
import { installFakeTransport } from "./fake-transport.js";
import { requestForCase } from "./request-cases.js";

const REASONING_CONTROL_FIELDS = [
  "reasoning",
  "reasoning_effort",
  "reasoning_budget",
  "reasoning_history",
  "thinking",
  "enable_thinking",
  "preserve_thinking",
  "thinking_budget",
  "chat_template_kwargs",
  "include_reasoning",
  "think",
] as const;

const EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const PURPOSES: readonly CompletionRequestPurpose[] = [
  "turn",
  "compaction",
  "auxiliary",
];

const ATTEMPT_REASONS: readonly GenerationAttemptReason[] = [
  "initial",
  "retry",
  "fallback",
  "adaptation",
  "provider-retry",
];

const CHAT_ROUTES = CONFORMANCE_ROUTES.filter(
  (route) => route.family === "chat_completions",
);

function controlSubset(body: unknown): string {
  const parsed =
    typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : body;
  const source = (parsed ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of REASONING_CONTROL_FIELDS) {
    if (field in source) picked[field] = source[field];
  }
  return JSON.stringify(picked);
}

function planFor(input: {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
  enabled: boolean;
  maxTokens?: number | undefined;
  stream: boolean;
}) {
  return compileRequestPlan({
    provider: input.provider,
    model: input.model,
    messages: [
      { role: "system", content: "stable system prefix for cache reuse" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first assistant answer" },
      { role: "user", content: "second user turn" },
    ],
    stream: input.stream,
    reasoning: { enabled: input.enabled, effort: input.effort },
    temperature: 0.2,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
}

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reasoning controls are a pure function of route, preference and model", () => {
  it("ignores maxTokens and stream across every route, effort and toggle", () => {
    for (const route of CHAT_ROUTES) {
      for (const effort of EFFORTS) {
        for (const enabled of [true, false]) {
          const reference = controlSubset(
            chatCompletionsBodyFromPlan(
              planFor({
                provider: route.provider,
                model: route.model,
                effort,
                enabled,
                maxTokens: 1_024,
                stream: false,
              }),
            ),
          );
          fc.assert(
            fc.property(
              fc.oneof(
                fc.constant(undefined),
                fc.integer({ min: 1, max: 400_000 }),
              ),
              fc.boolean(),
              (maxTokens, stream) => {
                const candidate = controlSubset(
                  chatCompletionsBodyFromPlan(
                    planFor({
                      provider: route.provider,
                      model: route.model,
                      effort,
                      enabled,
                      maxTokens,
                      stream,
                    }),
                  ),
                );
                expect(candidate).toBe(reference);
              },
            ),
            { numRuns: 25 },
          );
        }
      }
    }
  });

  it("keeps the plan prefix hash stable across maxTokens variation", () => {
    for (const route of CHAT_ROUTES) {
      const reference = planFor({
        provider: route.provider,
        model: route.model,
        effort: "high",
        enabled: true,
        maxTokens: 1_024,
        stream: true,
      }).cache.fingerprint.prefixSha256;
      fc.assert(
        fc.property(
          fc.oneof(fc.constant(undefined), fc.integer({ min: 1, max: 400_000 })),
          (maxTokens) => {
            expect(
              planFor({
                provider: route.provider,
                model: route.model,
                effort: "high",
                enabled: true,
                maxTokens,
                stream: true,
              }).cache.fingerprint.prefixSha256,
            ).toBe(reference);
          },
        ),
        { numRuns: 40 },
      );
    }
  });

  it("emits the same controls for a turn and a compaction request on the wire", async () => {
    for (const route of CHAT_ROUTES) {
      const bodies: string[] = [];
      for (const purpose of PURPOSES) {
        for (const attemptReason of ATTEMPT_REASONS) {
          const transport = installFakeTransport({
            family: route.family,
            mode: "complete",
            scenario: "answer",
            model: route.model,
          });
          const base = requestForCase(route, "reasoning-control");
          await providers[route.provider].complete(
            { ...base, purpose, attemptReason },
            route.auth,
          );
          bodies.push(controlSubset(transport.generations[0]!.body));
          vi.unstubAllGlobals();
        }
      }
      expect(new Set(bodies).size).toBe(1);
    }
  });
});
