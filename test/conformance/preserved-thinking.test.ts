import { describe, expect, it } from "vitest";

import { compatibleArtifactPolicyFor } from "../../src/llm/http.js";
import { emitReasoningControls } from "../../src/llm/reasoning-controls.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { reasoningArtifactsForPersistence } from "../../src/llm/reasoning-artifacts.js";
import { createReasoningArtifact } from "../../src/llm/reasoning-artifacts.js";
import { createReasoningArtifactProvenance } from "../../src/llm/reasoning-artifacts.js";
import type { ProviderId } from "../../src/llm/provider-ids.js";

function optIn(provider: ProviderId, model: string): Record<string, unknown> {
  return emitReasoningControls({
    profile: resolveBuiltInProfile({ provider, model }),
    preference: { enabled: true, effort: "high" },
    willReplayReasoning: true,
  }) as Record<string, unknown>;
}

function finalTurnArtifacts(provider: ProviderId, model: string) {
  const preservation =
    resolveBuiltInProfile({ provider, model }).reasoning.finalTurnPreservation;
  const policy = compatibleArtifactPolicyFor(preservation);
  const artifact = createReasoningArtifact({
    kind: "plaintext",
    raw: "the model's closing reasoning",
    displaySummary: "the model's closing reasoning",
    provenance: createReasoningArtifactProvenance({
      provider,
      model,
      dialect: "openai-compatible",
      endpoint: "https://route.example/v1",
    }),
    replay: policy,
    position: { sequence: 1, placement: "assistant" },
  });
  return reasoningArtifactsForPersistence({
    artifacts: [artifact],
    hasToolCalls: false,
  });
}

describe("the replay opt-in is selected by route class", () => {
  it("sends the Qwen vendor-native flag on a passthrough route", () => {
    expect(optIn("qwen-cloud", "qwen3.7-plus")).toMatchObject({
      preserve_thinking: true,
    });
  });

  it("sends Kimi's thinking.keep on a passthrough route", () => {
    expect(optIn("free", "kimi-k2.6")["thinking"]).toEqual({
      type: "enabled",
      keep: "all",
    });
  });

  it("sends OpenRouter's normalized context flag instead of a vendor flag", () => {
    const payload = optIn("openrouter", "qwen/qwen3.8-max");
    expect(payload["reasoning"]).toMatchObject({ context: "all_turns" });
    expect(payload).not.toHaveProperty("preserve_thinking");
  });

  it("never sends a vendor-native flag through a normalizing gateway", () => {
    for (const model of ["moonshotai/kimi-k2.6", "qwen/qwen3.7-plus"]) {
      const payload = optIn("openrouter", model);
      expect(payload).not.toHaveProperty("preserve_thinking");
      const thinking = payload["thinking"];
      if (thinking && typeof thinking === "object") {
        expect(thinking).not.toHaveProperty("keep");
      }
    }
  });

  it("omits the opt-in when nothing is replayed", () => {
    const payload = emitReasoningControls({
      profile: resolveBuiltInProfile({ provider: "qwen-cloud", model: "qwen3.7-plus" }),
      preference: { enabled: true, effort: "high" },
      willReplayReasoning: false,
    }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("preserve_thinking");
  });
});

describe("final-turn reasoning survives only where the route requires it", () => {
  it("retains the closing turn on a route with required preservation", () => {
    expect(
      resolveBuiltInProfile({ provider: "bynara", model: "kimi-k3" }).reasoning
        .finalTurnPreservation,
    ).toBe("required");
    expect(compatibleArtifactPolicyFor("required").persistence).toBe("all-turns");
    expect(finalTurnArtifacts("bynara", "kimi-k3")).toHaveLength(1);
  });

  it("retains it for kimi-k2.7-code as well", () => {
    expect(finalTurnArtifacts("tokenrouter", "moonshotai/kimi-k2.7-code")).toHaveLength(
      1,
    );
  });

  it("still drops it on a route that cannot use it", () => {
    expect(compatibleArtifactPolicyFor("unsupported").persistence).toBe("tool-turn");
    expect(finalTurnArtifacts("bynara", "kimi-k2.5")).toBeUndefined();
  });

  it("leaves unknown-preservation routes on their existing byte layout", () => {
    expect(compatibleArtifactPolicyFor("unknown").persistence).toBe("tool-turn");
    expect(compatibleArtifactPolicyFor("supported").persistence).toBe("tool-turn");
  });
});
