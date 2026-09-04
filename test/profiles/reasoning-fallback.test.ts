import { afterEach, describe, expect, it } from "vitest";
import {
  displayReasoningEfforts,
  effectiveThinkingEffort,
  markReasoningUnsupported,
  modelReasoningEvidence,
  modelSupportsThinking,
  registerModelReasoningSupport,
  registerRouteAcceptedEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";

const UNLISTED = "free-2/brand-new-model-nobody-listed:free";
const PROBED_EFFORTS = ["none", "low", "medium", "high"];

afterEach(() => {
  resetReasoningKnowledge();
});

describe("reasoning capability fallback for unlisted models", () => {
  it("gives an unlisted free model the endpoint contract", () => {
    expect(modelSupportsThinking("free", UNLISTED)).toBe(true);
    expect(modelReasoningEvidence("free", UNLISTED)).toBe("endpoint");
    expect(displayReasoningEfforts("free", UNLISTED)).toEqual(PROBED_EFFORTS);
  });

  it("clamps a requested effort the endpoint does not accept", () => {
    expect(
      effectiveThinkingEffort("free", UNLISTED, { enabled: true, effort: "max" }),
    ).toBe("high");
  });

  it("does not invent a contract for providers without one", () => {
    expect(modelSupportsThinking("ollama", "llama-3.3-70b")).toBe(false);
    expect(modelReasoningEvidence("ollama", "llama-3.3-70b")).toBe("unknown");
    expect(displayReasoningEfforts("ollama", "llama-3.3-70b")).toBeUndefined();
  });

  it("yields to a runtime rejection", () => {
    markReasoningUnsupported("free", UNLISTED);
    expect(modelSupportsThinking("free", UNLISTED)).toBe(false);
    expect(modelReasoningEvidence("free", UNLISTED)).toBe("rejected");
    expect(
      effectiveThinkingEffort("free", UNLISTED, { enabled: true, effort: "high" }),
    ).toBeUndefined();
  });

  it("yields to a catalog declaration", () => {
    registerModelReasoningSupport("free", UNLISTED, false);
    expect(modelSupportsThinking("free", UNLISTED)).toBe(false);
    expect(modelReasoningEvidence("free", UNLISTED)).toBe("catalog");
  });

  it("prefers efforts learned from the route over the endpoint default", () => {
    registerRouteAcceptedEfforts("free", UNLISTED, ["low", "high"]);
    expect(displayReasoningEfforts("free", UNLISTED)).toEqual(["low", "high"]);
    expect(
      effectiveThinkingEffort("free", UNLISTED, { enabled: true, effort: "xhigh" }),
    ).toBe("high");
  });

  it("keeps the endpoint default out of profile resolution for claimed families", async () => {
    const { resolveBuiltInProfile } = await import(
      "../../src/llm/provider-profiles.js"
    );
    const { emitReasoningControls } = await import(
      "../../src/llm/reasoning-controls.js"
    );
    expect(
      emitReasoningControls({
        profile: resolveBuiltInProfile({ provider: "free", model: "kimi-k2.6" }),
        preference: { enabled: true, effort: "high" },
        willReplayReasoning: false,
      }),
    ).toEqual({ thinking: { type: "enabled" } });
  });
});
