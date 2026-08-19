import { describe, expect, it } from "vitest";

import type { ReasoningEffort } from "../../src/types.js";
import {
  emitReasoningControls,
  nearestAcceptedEffort,
} from "../../src/llm/reasoning-controls.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import type { ProviderId } from "../../src/llm/provider-ids.js";

const EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const DEPTHS: readonly ReasoningEffort[] = EFFORTS.filter(
  (effort) => effort !== "none",
);

function emit(
  provider: ProviderId,
  model: string,
  enabled: boolean,
  effort: ReasoningEffort,
  willReplayReasoning = false,
): Readonly<Record<string, unknown>> {
  return emitReasoningControls({
    profile: resolveBuiltInProfile({ provider, model }),
    preference: { enabled, effort },
    willReplayReasoning,
  });
}

describe("nearestAcceptedEffort walks outward from the request", () => {
  it("takes one hop up when the requested level is absent", () => {
    expect(nearestAcceptedEffort("medium", ["low", "high", "max"])).toBe("high");
  });

  it("returns the request when it is accepted", () => {
    expect(nearestAcceptedEffort("high", ["low", "high", "max"])).toBe("high");
    expect(nearestAcceptedEffort("max", ["low", "high", "max"])).toBe("max");
  });

  it("reaches the vendor-specific top of the scale", () => {
    expect(nearestAcceptedEffort("max", ["low", "medium", "xhigh"])).toBe("xhigh");
    expect(nearestAcceptedEffort("high", ["low", "medium", "xhigh"])).toBe("xhigh");
  });

  it("never invents a level outside the accepted list", () => {
    for (const effort of EFFORTS) {
      const accepted = ["low", "high", "max"];
      const result = nearestAcceptedEffort(effort, accepted);
      expect(accepted).toContain(result);
    }
    for (const effort of EFFORTS) {
      const accepted = ["low", "medium", "xhigh"];
      expect(accepted).toContain(nearestAcceptedEffort(effort, accepted));
    }
  });

  it("returns undefined when the route has no effort knob", () => {
    expect(nearestAcceptedEffort("high", [])).toBeUndefined();
  });

  it("is case and whitespace tolerant", () => {
    expect(nearestAcceptedEffort("medium", [" HIGH ", "Low"])).toBe("high");
  });
});

describe("kimi-k3 never receives medium and is never disabled", () => {
  it("maps every requested effort into low|high|max", () => {
    for (const effort of DEPTHS) {
      const payload = emit("tokenrouter", "moonshotai/kimi-k3", true, effort);
      expect(["low", "high", "max"]).toContain(payload["reasoning_effort"]);
      expect(payload["reasoning_effort"]).not.toBe("medium");
      expect(payload).not.toHaveProperty("thinking");
    }
  });

  it("resolves the default medium request to high, not medium", () => {
    expect(emit("tokenrouter", "moonshotai/kimi-k3", true, "medium")).toEqual({
      reasoning_effort: "high",
    });
  });

  it("reaches max, which the old clamp could never emit", () => {
    expect(emit("tokenrouter", "moonshotai/kimi-k3", true, "max")).toEqual({
      reasoning_effort: "max",
    });
  });

  it("degrades a disable request to the cheapest legal effort", () => {
    const payload = emit("tokenrouter", "moonshotai/kimi-k3", false, "medium");
    expect(payload).toEqual({ reasoning_effort: "low" });
  });
});

describe("a mandatory-reasoning gateway route is never silent", () => {
  it("always carries an effort the gateway validates", () => {
    for (const effort of EFFORTS) {
      for (const enabled of [true, false]) {
        const payload = emit(
          "tokenrouter",
          "moonshotai/kimi-k2.7-code",
          enabled,
          effort,
        );
        expect(payload).not.toHaveProperty("thinking");
        expect(["low", "medium", "minimal", "high", "max", "xhigh"]).toContain(
          payload["reasoning_effort"],
        );
      }
    }
  });

  it("falls back to the cheapest accepted effort when asked to turn off", () => {
    expect(emit("tokenrouter", "moonshotai/kimi-k2.7-code", false, "max")).toEqual({
      reasoning_effort: "minimal",
    });
  });
});

describe("a route that declares the vendor thinking toggle uses it", () => {
  it("enables and disables through the vendor toggle", () => {
    expect(emit("free", "kimi-k2.6", true, "high")).toEqual({
      thinking: { type: "enabled" },
    });
    expect(emit("free", "kimi-k2.6", false, "high")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("never sends reasoning_effort for any requested level", () => {
    for (const effort of DEPTHS) {
      expect(
        emit("free", "kimi-k2.6", true, effort),
      ).not.toHaveProperty("reasoning_effort");
    }
  });

  it("opts into thinking.keep only when reasoning is replayed", () => {
    expect(
      emit("free", "kimi-k2.6", true, "high", true),
    ).toEqual({ thinking: { type: "enabled", keep: "all" } });
    expect(
      emit("free", "kimi-k2.6", true, "high", false),
    ).toEqual({ thinking: { type: "enabled" } });
  });

  it("does not opt in while disabled", () => {
    expect(
      emit("free", "kimi-k2.6", false, "high", true),
    ).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("deepseek-v4 pairs the vendor toggle with its own effort vocabulary", () => {
  it("pairs thinking.type with low|high|max", () => {
    for (const effort of DEPTHS) {
      const payload = emit("free", "deepseek-v4-pro", true, effort);
      expect(payload["thinking"]).toEqual({ type: "enabled" });
      expect(["low", "high", "max"]).toContain(payload["reasoning_effort"]);
    }
  });

  it("disables through the toggle and drops the effort", () => {
    expect(emit("free", "deepseek-v4-pro", false, "high")).toEqual({
      thinking: { type: "disabled" },
    });
  });
});

describe("qwen routes use enable_thinking with the right depth control", () => {
  it("qwen3.8-max never receives high and never pairs effort with a budget", () => {
    for (const effort of DEPTHS) {
      const payload = emit("qwen-cloud", "qwen3.8-max", true, effort);
      expect(payload["enable_thinking"]).toBe(true);
      expect(["low", "medium", "xhigh"]).toContain(payload["reasoning_effort"]);
      expect(payload["reasoning_effort"]).not.toBe("high");
      expect(payload).not.toHaveProperty("thinking_budget");
    }
  });

  it("hybrid qwen routes use thinking_budget because they have no effort enum", () => {
    const payload = emit("qwen-cloud", "qwen3.7-plus", true, "high");
    expect(payload["enable_thinking"]).toBe(true);
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(typeof payload["thinking_budget"]).toBe("number");
  });

  it("disables with enable_thinking:false rather than by omission", () => {
    expect(emit("qwen-cloud", "qwen3.7-plus", false, "high")).toEqual({
      enable_thinking: false,
    });
  });

  it("adds preserve_thinking only when replaying", () => {
    expect(emit("qwen-cloud", "qwen3.7-plus", true, "high", true)).toMatchObject({
      preserve_thinking: true,
    });
    expect(
      emit("qwen-cloud", "qwen3.7-plus", true, "high", false),
    ).not.toHaveProperty("preserve_thinking");
  });
});

describe("an observed rejection suppresses every control", () => {
  it("emits nothing when the profile says the control is unsupported", () => {
    const profile = resolveBuiltInProfile({
      provider: "tokenrouter",
      model: "moonshotai/kimi-k3",
    });
    const suppressed = {
      ...profile,
      reasoning: {
        ...profile.reasoning,
        control: { ...profile.reasoning.control, status: "unsupported" as const },
      },
    };
    expect(
      emitReasoningControls({
        profile: suppressed,
        preference: { enabled: true, effort: "max" },
        willReplayReasoning: true,
      }),
    ).toEqual({});
  });
});

describe("the emitter is a pure function of its inputs", () => {
  it("returns identical payloads for repeated identical calls", () => {
    for (const effort of DEPTHS) {
      const first = emit("tokenrouter", "moonshotai/kimi-k3", true, effort);
      const second = emit("tokenrouter", "moonshotai/kimi-k3", true, effort);
      expect(first).toEqual(second);
    }
  });

  it("never emits an empty nested object", () => {
    for (const model of [
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.6",
      "deepseek/deepseek-v4-pro",
      "qwen3.7-plus",
    ]) {
      for (const effort of DEPTHS) {
        const payload = emit("tokenrouter", model, true, effort);
        for (const value of Object.values(payload)) {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            expect(Object.keys(value).length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
