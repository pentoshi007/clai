import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatMessage,
  ReasoningArtifact,
  ReasoningArtifactDialect,
  ReasoningArtifactOmissionReason,
  ReasoningArtifactReplayDecision,
} from "../../src/types.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { geminiBody } from "../../src/llm/gemini.js";
import { openAiCompatibleComplete } from "../../src/llm/http.js";
import { metaProvider } from "../../src/llm/meta.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
  createReasoningArtifactReplayTarget,
  selectReasoningArtifactsForReplay,
} from "../../src/llm/reasoning-artifacts.js";
import { installTransport } from "./fake-transport.js";
import { jsonResponse } from "./wire-fixtures.js";

const OPAQUE_MARKER = "opaque-route-artifact-placeholder";

function createArtifact(input: {
  provider: "anthropic" | "aws-mantle" | "gemini" | "meta" | "openrouter";
  model: string;
  dialect: ReasoningArtifactDialect;
  endpoint: string;
  kind: ReasoningArtifact["kind"];
  raw: ReasoningArtifact["raw"];
}): ReasoningArtifact {
  return createReasoningArtifact({
    kind: input.kind,
    raw: input.raw,
    provenance: createReasoningArtifactProvenance({
      provider: input.provider,
      model: input.model,
      dialect: input.dialect,
      endpoint: input.endpoint,
    }),
    replay: { scope: "all-history", persistence: "all-turns" },
    position: { sequence: 0, placement: "before-tool-call", toolCallIndex: 0 },
  });
}

function toolHistory(artifact: ReasoningArtifact): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "route-filter-tool",
          name: "fs.read",
          args: { path: "synthetic.md" },
        },
      ],
      reasoningArtifacts: [artifact],
    },
  ];
}

function expectOmission(
  decisions: readonly ReasoningArtifactReplayDecision[],
  reason: ReasoningArtifactOmissionReason,
): void {
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ action: "omitted", reason });
  expect(decisions[0]).not.toHaveProperty("raw");
  expect(JSON.stringify(decisions[0])).not.toContain(OPAQUE_MARKER);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T220 route compatibility filtering", () => {
  it("omits provider, model, endpoint, and dialect mismatches with metadata-only reasons", () => {
    const compatibleSource = createArtifact({
      provider: "openrouter",
      model: "route-source",
      dialect: "openai-compatible",
      endpoint: "https://route-source.example/v1",
      kind: "structured-details",
      raw: { type: "reasoning.encrypted", payload: OPAQUE_MARKER },
    });
    const dialectSource = createArtifact({
      provider: "aws-mantle",
      model: "route-source",
      dialect: "anthropic-messages",
      endpoint: "https://route-source.example/anthropic/v1",
      kind: "signed",
      raw: { thinking: "synthetic", signature: OPAQUE_MARKER },
    });
    const cases: Array<{
      artifact: ReasoningArtifact;
      reason: ReasoningArtifactOmissionReason;
      target: ReturnType<typeof createReasoningArtifactReplayTarget>;
    }> = [
      {
        artifact: compatibleSource,
        reason: "provider-mismatch",
        target: createReasoningArtifactReplayTarget({
          provider: "openai",
          model: "route-source",
          dialect: "openai-compatible",
          endpoint: "https://route-source.example/v1",
        }),
      },
      {
        artifact: compatibleSource,
        reason: "model-mismatch",
        target: createReasoningArtifactReplayTarget({
          provider: "openrouter",
          model: "route-target",
          dialect: "openai-compatible",
          endpoint: "https://route-source.example/v1",
        }),
      },
      {
        artifact: compatibleSource,
        reason: "endpoint-mismatch",
        target: createReasoningArtifactReplayTarget({
          provider: "openrouter",
          model: "route-source",
          dialect: "openai-compatible",
          endpoint: "https://route-target.example/v1",
        }),
      },
      {
        artifact: dialectSource,
        reason: "dialect-mismatch",
        target: createReasoningArtifactReplayTarget({
          provider: "aws-mantle",
          model: "route-source",
          dialect: "openai-compatible",
          endpoint: "https://route-source.example/anthropic/v1",
        }),
      },
    ];

    for (const testCase of cases) {
      const decisions: ReasoningArtifactReplayDecision[] = [];
      const selected = selectReasoningArtifactsForReplay({
        artifacts: [testCase.artifact],
        target: testCase.target,
        observe: (decision) => decisions.push(decision),
      });
      expect(selected).toEqual([]);
      expectOmission(decisions, testCase.reason);
    }
  });

  it("filters wire projection at Anthropic, Gemini, Meta, and compatible boundaries without mutating history", async () => {
    const sourceModel = "route-source";
    const targetModel = "route-target";

    const anthropicArtifact = createArtifact({
      provider: "anthropic",
      model: sourceModel,
      dialect: "anthropic-messages",
      endpoint: "https://api.anthropic.com/v1",
      kind: "signed",
      raw: {
        type: "thinking",
        thinking: "synthetic thought",
        signature: OPAQUE_MARKER,
      },
    });
    const anthropicDecisions: ReasoningArtifactReplayDecision[] = [];
    const anthropicBody = buildAnthropicBody(
      {
        model: targetModel,
        messages: toolHistory(anthropicArtifact),
        onReasoningArtifactReplayDecision: (decision) =>
          anthropicDecisions.push(decision),
      },
      false,
    );
    expect(anthropicBody).not.toContain(OPAQUE_MARKER);
    expectOmission(anthropicDecisions, "model-mismatch");

    const geminiArtifact = createArtifact({
      provider: "gemini",
      model: sourceModel,
      dialect: "gemini-generate-content",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      kind: "thought-signature",
      raw: OPAQUE_MARKER,
    });
    const geminiDecisions: ReasoningArtifactReplayDecision[] = [];
    const geminiRequest = {
      model: targetModel,
      messages: toolHistory(geminiArtifact),
      onReasoningArtifactReplayDecision: (decision: ReasoningArtifactReplayDecision) =>
        geminiDecisions.push(decision),
    };
    expect(geminiBody(geminiRequest)).not.toContain(OPAQUE_MARKER);
    expectOmission(geminiDecisions, "model-mismatch");

    const metaArtifact = createArtifact({
      provider: "meta",
      model: sourceModel,
      dialect: "meta-responses",
      endpoint: "https://api.meta.ai/v1",
      kind: "encrypted",
      raw: { type: "reasoning", encrypted_content: OPAQUE_MARKER },
    });
    const metaHistory = toolHistory(metaArtifact);
    const metaDecisions: ReasoningArtifactReplayDecision[] = [];
    const metaTransport = installTransport(() =>
      jsonResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      }),
    );
    await metaProvider.complete(
      {
        model: targetModel,
        messages: metaHistory,
        onReasoningArtifactReplayDecision: (decision) => metaDecisions.push(decision),
      },
      { apiKey: "synthetic-key" },
    );
    expect(JSON.stringify(metaTransport.generations[0]?.body)).not.toContain(
      OPAQUE_MARKER,
    );
    expectOmission(metaDecisions, "model-mismatch");

    vi.unstubAllGlobals();
    const compatibleArtifact = createArtifact({
      provider: "openrouter",
      model: sourceModel,
      dialect: "openai-compatible",
      endpoint: "https://route-source.example/v1",
      kind: "structured-details",
      raw: { type: "reasoning.encrypted", payload: OPAQUE_MARKER },
    });
    const compatibleHistory = toolHistory(compatibleArtifact);
    const originalRaw = compatibleArtifact.raw;
    const compatibleDecisions: ReasoningArtifactReplayDecision[] = [];
    const compatibleTransport = installTransport(() =>
      jsonResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      }),
    );
    await openAiCompatibleComplete({
      provider: "OpenRouter synthetic",
      providerId: "openrouter",
      baseUrl: "https://route-source.example/v1",
      apiKey: "synthetic-key",
      model: targetModel,
      messages: compatibleHistory,
      reasoningArtifactReplayObserver: (decision) =>
        compatibleDecisions.push(decision),
    });
    expect(
      JSON.stringify(compatibleTransport.generations[0]?.body),
    ).not.toContain(OPAQUE_MARKER);
    expectOmission(compatibleDecisions, "model-mismatch");
    expect(compatibleHistory[0]?.reasoningArtifacts?.[0]).toBe(
      compatibleArtifact,
    );
    expect(compatibleArtifact.raw).toBe(originalRaw);
  });
});
