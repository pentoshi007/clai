import { afterEach, describe, expect, it } from "vitest";
import {
  displayReasoningEfforts,
  markReasoningMandatory,
  markReasoningUnsupported,
  modelReasoningEvidence,
  modelSupportsThinking,
  registerWireRejectionEfforts,
  resetReasoningKnowledge,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { reasoningRejectionAdvice } from "../../src/llm/http.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { emitReasoningControls } from "../../src/llm/reasoning-controls.js";
import { effortCandidatesFor } from "../../src/llm/router.js";

const MODEL = "x-preview-f-free";

const rejection = (message: string): Error =>
  Object.assign(new Error("Provider request failed with HTTP 400"), {
    status: 400,
    body: JSON.stringify({ error: { type: "server_error", message } }),
  });

const MANDATORY_1210 = rejection(
  "Error from provider (Console): Upstream request failed: [1210] This model " +
    "always engages in thinking and cannot be disabled; please use low, high, or max",
);

const emit = (effort: string, enabled = true): Record<string, unknown> | undefined =>
  emitReasoningControls({
    profile: resolveBuiltInProfile({ provider: "free", model: MODEL }),
    preference: { enabled, effort: effort as never },
    willReplayReasoning: false,
  }) as Record<string, unknown> | undefined;

const learnFromRejection = (): void => {
  const advice = reasoningRejectionAdvice(MANDATORY_1210);
  if (advice?.acceptedEfforts.length) {
    registerWireRejectionEfforts("free", MODEL, advice.acceptedEfforts);
  }
  if (advice?.mandatory) markReasoningMandatory("free", MODEL);
};

afterEach(() => {
  resetReasoningKnowledge();
});

describe("reasoningRejectionAdvice", () => {
  it("reads the mandatory signal and the accepted vocabulary", () => {
    expect(reasoningRejectionAdvice(MANDATORY_1210)).toEqual({
      mandatory: true,
      acceptedEfforts: ["low", "high", "max"],
    });
  });

  it("reads an explicit one-of list", () => {
    expect(
      reasoningRejectionAdvice(
        rejection("reasoning_effort must be one of: none, low, medium, high"),
      ),
    ).toEqual({
      mandatory: false,
      acceptedEfforts: ["none", "low", "medium", "high"],
    });
  });

  it("stays silent on unrelated failures", () => {
    expect(
      reasoningRejectionAdvice(
        rejection("Unrecognized request argument supplied: reasoning_effort"),
      ),
    ).toBeUndefined();
    expect(
      reasoningRejectionAdvice(rejection("Rate limit exceeded, retry in 8s")),
    ).toBeUndefined();
  });
});

describe("a model that mandates thinking", () => {
  it("never sends a disable form once learned", () => {
    expect(emit("high", false)).toEqual({ reasoning_effort: "none" });
    learnFromRejection();
    expect(emit("high", false)).toEqual({ reasoning_effort: "low" });
  });

  it("clamps every requested level into the learned vocabulary", () => {
    learnFromRejection();
    expect(emit("medium")).toEqual({ reasoning_effort: "high" });
    expect(emit("minimal")).toEqual({ reasoning_effort: "low" });
    expect(emit("xhigh")).toEqual({ reasoning_effort: "max" });
    expect(emit("max")).toEqual({ reasoning_effort: "max" });
  });

  it("reports the learned contract on the profile", () => {
    learnFromRejection();
    const profile = resolveBuiltInProfile({ provider: "free", model: MODEL });
    expect(profile.reasoning.acceptedEfforts).toEqual(["low", "high", "max"]);
    expect(profile.reasoning.generation).toBe("mandatory");
    expect(profile.reasoning.disable).toBe("unsupported");
    expect(routeReasoningIsMandatory("free", MODEL)).toBe(true);
  });

  it("takes exactly one corrected hop, not a ladder", () => {
    learnFromRejection();
    expect(effortCandidatesFor("free", MODEL, "medium")).toEqual(["high"]);
    expect(effortCandidatesFor("free", MODEL, "minimal")).toEqual(["low"]);
  });

  it("is not marked reasoning-unsupported, so the knob stays usable", () => {
    learnFromRejection();
    expect(modelSupportsThinking("free", MODEL)).toBe(true);
    expect(displayReasoningEfforts("free", MODEL)).toEqual(["low", "high", "max"]);
  });

  it("recovers a route that was already marked unsupported", () => {
    markReasoningUnsupported("free", MODEL);
    expect(modelSupportsThinking("free", MODEL)).toBe(false);
    expect(modelReasoningEvidence("free", MODEL)).toBe("rejected");
    learnFromRejection();
    expect(modelSupportsThinking("free", MODEL)).toBe(true);
    expect(emit("high", false)).toEqual({ reasoning_effort: "low" });
  });

  it("leaves other free models on the endpoint default", () => {
    learnFromRejection();
    expect(displayReasoningEfforts("free", "hy3-free")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
