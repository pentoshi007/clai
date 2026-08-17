import { describe, expect, it } from "vitest";

import { buildContextBreakdown } from "../../src/agent/context-breakdown.js";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "../../src/agent/context-manager.js";
import {
  canonicalizeChatMessageReasoningArtifacts,
  createReasoningArtifact,
  legacyReasoningBlockFromArtifacts,
  reasoningArtifactTokensForMessage,
  reasoningArtifactsForMessage,
} from "../../src/llm/reasoning-artifacts.js";
import type { ChatMessage, ReasoningArtifact } from "../../src/types.js";

function fixtureArtifact(input: {
  raw: ReasoningArtifact["raw"];
  kind?: ReasoningArtifact["kind"];
  displaySummary?: string;
}): ReasoningArtifact {
  return createReasoningArtifact({
    kind: input.kind ?? "structured-details",
    raw: input.raw,
    ...(input.displaySummary !== undefined
      ? { displaySummary: input.displaySummary }
      : {}),
    provenance: {
      provider: "openrouter",
      model: "fixture-model",
      dialect: "openai-compatible",
    },
    replay: { scope: "all-history", persistence: "all-turns" },
    position: { sequence: 0, placement: "assistant" },
  });
}

describe("canonical reasoning artifacts", () => {
  it("round-trips legacy reasoning blocks without duplicate canonical artifacts", () => {
    const legacy: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_legacy_1",
          name: "fs.read",
          args: { path: "docs/example.md" },
          thoughtSignature: "gemini-thought-signature",
        },
      ],
      reasoningBlock: {
        text: "provider thinking",
        signature: "anthropic-signature",
        items: [
          {
            type: "reasoning",
            id: "meta-reasoning-item",
            encrypted_content: "meta-encrypted-content",
          },
        ],
      },
    };

    const canonical = canonicalizeChatMessageReasoningArtifacts(legacy);
    const artifacts = canonical.reasoningArtifacts ?? [];

    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "signed",
      "encrypted",
      "thought-signature",
    ]);
    expect(legacyReasoningBlockFromArtifacts(artifacts)).toEqual(
      legacy.reasoningBlock,
    );
    expect(artifacts[2]?.position).toMatchObject({
      placement: "on-tool-call",
      toolCallId: "call_legacy_1",
      toolCallIndex: 0,
    });
    expect(reasoningArtifactsForMessage(canonical)).toHaveLength(3);
  });

  it("clones and freezes opaque raw state independently from display summary", () => {
    const source = {
      reasoning_details: [
        { type: "opaque", payload: "private-provider-state" },
      ],
    };
    const artifact = fixtureArtifact({
      raw: source,
      displaySummary: "safe display summary",
    });

    source.reasoning_details[0]!.payload = "mutated-source-state";

    expect(artifact.displaySummary).toBe("safe display summary");
    expect(artifact.raw).toEqual({
      reasoning_details: [
        { type: "opaque", payload: "private-provider-state" },
      ],
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.raw)).toBe(true);
    expect(
      Object.isFrozen(
        (artifact.raw as { reasoning_details: readonly unknown[] })
          .reasoning_details,
      ),
    ).toBe(true);
    expect(() => {
      (artifact.raw as Record<string, unknown>).reasoning_details = [];
    }).toThrow(TypeError);
  });

  it("adds raw artifact size to message and assistant context accounting", () => {
    const artifact = fixtureArtifact({ raw: "x".repeat(330) });
    const message: ChatMessage = {
      role: "assistant",
      content: "visible answer",
      reasoningArtifacts: [artifact],
    };
    const visibleTokens = estimateTokens(message.content) + 4;
    const artifactTokens = reasoningArtifactTokensForMessage(message);
    const breakdown = buildContextBreakdown([message]);

    expect(artifact.accounting).toEqual({
      byteLength: 330,
      estimatedTokens: 100,
    });
    expect(artifactTokens).toBe(100);
    expect(estimateMessagesTokens([message])).toBe(visibleTokens + 100);
    expect(breakdown.assistantTokens).toBe(visibleTokens + 100);
    expect(breakdown.estimatedTotalTokens).toBe(visibleTokens + 100);
  });
});
