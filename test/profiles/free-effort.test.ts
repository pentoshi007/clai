import { describe, expect, it } from "vitest";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { emitReasoningControls } from "../../src/llm/reasoning-controls.js";
import type { ReasoningEffort } from "../../src/types.js";

const FAMILYLESS_FREE_MODELS = [
  "free-1/x-preview-f-free",
  "free-1/muse-spark-1.2-contributor-free",
  "free-1/hy3-free",
  "free-1/mimo-v2.5-free",
  "free-1/laguna-s-2.1-free",
  "free-2/kilo-auto/free",
  "free-2/stepfun/step-3.7-flash:free",
  "free-2/tencent/hy3:free",
  "free-2/poolside/laguna-xs-2.1:free",
  "free-2/cohere/north-mini-code:free",
  "free-2/liquid/lfm-2.5-2.6b:free",
  "free-2/dots-studio/dots-3-note-preview:free",
  "free-2/inclusionai/ling-3.0-tiny:free",
  "free-2/openrouter/free",
];

const PROBED_EFFORTS = ["none", "low", "medium", "high"];

const freeReasoning = (model: string) =>
  resolveBuiltInProfile({ provider: "free", model }).reasoning;

describe("free gateway reasoning effort", () => {
  it.each(FAMILYLESS_FREE_MODELS)("exposes an effort knob for %s", (model) => {
    const reasoning = freeReasoning(model);
    expect(reasoning.control.dialect).toBe("openai-effort");
    expect(reasoning.control.status).toBe("supported");
    expect(reasoning.generation).toBe("optional");
    expect(reasoning.acceptedEfforts).toEqual(PROBED_EFFORTS);
  });

  it("omits max because the gateway rejects it", () => {
    expect(freeReasoning("free-1/hy3-free").acceptedEfforts).not.toContain("max");
  });

  it("disables reasoning through effort none", () => {
    const reasoning = freeReasoning("free-1/hy3-free");
    expect(reasoning.disable).toBe("supported");
    expect(reasoning.disableForm).toBe("effort-none");
  });

  it("accepts both reasoning field shapes the gateways return", () => {
    const shapes = freeReasoning("free-1/hy3-free").outputShapes;
    expect(shapes).toContain("reasoning-content");
    expect(shapes).toContain("reasoning-field");
    expect(shapes).toContain("structured-details");
  });

  it("reserves visible answer tokens under a shared reasoning cap", () => {
    const budget = resolveBuiltInProfile({
      provider: "free",
      model: "free-1/hy3-free",
    }).outputBudget;
    expect(budget.sharedReasoningCap).toBe(true);
    expect(budget.visibleAnswerReserveTokens).toBeGreaterThan(0);
  });

  it("keeps vendor toggles for models a family claims", () => {
    expect(freeReasoning("free-1/deepseek-v4-flash-free").control.dialect).toBe(
      "deepseek-thinking",
    );
    expect(
      freeReasoning("free-2/nvidia/nemotron-3-ultra-550b-a55b:free").control.dialect,
    ).toBe("nemotron-reasoning-budget");
  });

  it("applies the endpoint contract to rotating catalog additions", () => {
    expect(freeReasoning("free-1/some-future-free").control.dialect).toBe(
      "openai-effort",
    );
  });

  it("leaves other providers untouched", () => {
    expect(
      resolveBuiltInProfile({ provider: "openai", model: "gpt-5.4-mini" }).reasoning
        .acceptedEfforts,
    ).not.toEqual(PROBED_EFFORTS);
    expect(
      resolveBuiltInProfile({ provider: "aws-mantle", model: "mystery-hosted-1" })
        .reasoning.control.dialect,
    ).toBe("none");
  });

  const emit = (model: string, enabled: boolean, effort: ReasoningEffort) =>
    emitReasoningControls({
      profile: resolveBuiltInProfile({ provider: "free", model }),
      preference: { enabled, effort },
      willReplayReasoning: false,
    });

  it("emits the requested effort on the wire", () => {
    expect(emit("free-1/muse-spark-1.2-contributor-free", true, "high")).toEqual({
      reasoning_effort: "high",
    });
    expect(emit("free-1/x-preview-f-free", true, "medium")).toEqual({
      reasoning_effort: "medium",
    });
    expect(emit("free-2/kilo-auto/free", true, "low")).toEqual({
      reasoning_effort: "low",
    });
  });

  it("maps unsupported efforts to the nearest accepted one", () => {
    expect(emit("free-1/mimo-v2.5-free", true, "xhigh")).toEqual({
      reasoning_effort: "high",
    });
    expect(emit("free-1/hy3-free", true, "max")).toEqual({
      reasoning_effort: "high",
    });
    expect(emit("free-2/kilo-auto/free", true, "minimal")).toEqual({
      reasoning_effort: "low",
    });
  });

  it("turns thinking off through effort none", () => {
    expect(emit("free-1/hy3-free", false, "none")).toEqual({
      reasoning_effort: "none",
    });
  });
});
