import { describe, expect, it } from "vitest";

import {
  MODEL_FAMILIES,
  bareModelId,
  classifyBynaraModel,
  classifyNvidiaModel,
  modelFamilyFor,
  modelFamilyId,
} from "../../src/llm/model-families.js";

describe("bare model id normalization", () => {
  it("strips every namespace form seen on live gateways", () => {
    expect(bareModelId("moonshotai/kimi-k3")).toBe("kimi-k3");
    expect(bareModelId("moonshotai/Kimi-K3")).toBe("kimi-k3");
    expect(bareModelId("accounts/fireworks/models/kimi-k2p6")).toBe("kimi-k2.6");
    expect(bareModelId("accounts/fireworks/routers/qwen3p7-plus")).toBe("qwen3.7-plus");
    expect(bareModelId("kimi/kimi-k3")).toBe("kimi-k3");
    expect(bareModelId("free-1/deepseek-v4-flash-free")).toBe("deepseek-v4-flash-free");
    expect(bareModelId("Qwen/Qwen3.6-35B-A3B-FP8")).toBe("qwen3.6-35b-a3b-fp8");
  });

  it("restores p-for-decimal mangling without touching fp4 or fp8 suffixes", () => {
    expect(bareModelId("glm-5p2")).toBe("glm-5.2");
    expect(bareModelId("kimi-k2p7-code")).toBe("kimi-k2.7-code");
    expect(bareModelId("nemotron-lightning-3p5-30b-a3b")).toBe(
      "nemotron-lightning-3.5-30b-a3b",
    );
    expect(bareModelId("nemotron-3-super-fp4")).toBe("nemotron-3-super-fp4");
    expect(bareModelId("Qwen/Qwen3.6-35B-A3B-FP8")).toContain("fp8");
  });
});

describe("family resolution is stable across gateway id spellings", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["kimi-k3", "kimi-k3"],
    ["moonshotai/kimi-k3", "kimi-k3"],
    ["moonshotai/Kimi-K3", "kimi-k3"],
    ["accounts/fireworks/models/kimi-k3", "kimi-k3"],
    ["kimi/kimi-k3", "kimi-k3"],
    ["kimi-k3-0711", "kimi-k3"],
    ["moonshotai/kimi-k2.7-code", "kimi-k2.7-code"],
    ["accounts/fireworks/models/kimi-k2p7-code", "kimi-k2.7-code"],
    ["kimi-k2.6", "kimi-k2.6"],
    ["accounts/fireworks/models/kimi-k2p6", "kimi-k2.6"],
    ["moonshotai.kimi-k2-thinking", "kimi-k2.6"],
    ["moonshotai/kimi-k2-instruct", "kimi-k2.6"],
    ["moonshotai.kimi-k2.5", "kimi-k2.5"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4"],
    ["deepseek-v4-pro-0813", "deepseek-v4"],
    ["free-1/deepseek-v4-flash-free", "deepseek-v4"],
    ["deepseek.v3.2", "deepseek-reasoner"],
    ["deepseek/deepseek-reasoner", "deepseek-reasoner"],
    ["deepseek-ai/deepseek-r1", "deepseek-reasoner"],
    ["qwen/qwen3.8-max", "qwen3-max-effort"],
    ["qwen3p8-max", "qwen3-max-effort"],
    ["qwen-3.8-max-free", "qwen3-max-effort"],
    ["qwen/qwen3-vl-235b-a22b-thinking", "qwen-thinking-only"],
    ["qwen3.7-plus", "qwen3-hybrid"],
    ["accounts/fireworks/models/qwen3p7-plus", "qwen3-hybrid"],
    ["Qwen/Qwen3.6-35B-A3B-FP8", "qwen3-hybrid"],
    ["qwen.qwen3-32b", "qwen3-hybrid"],
    ["glm-5p2", "glm"],
    ["z-ai/glm-5.1", "glm"],
    ["ZHIPU/GLM-5.3", "glm"],
    ["zai.glm-4.7-flash", "glm"],
    ["openai/gpt-oss-120b", "gpt-oss"],
    ["openai.gpt-oss-20b", "gpt-oss"],
    ["nvidia/nemotron-3.5-lightning", "nemotron-3"],
    ["nemotron-lightning-3p5-30b-a3b", "nemotron-3"],
    ["nvidia/llama-3.3-nemotron-super-49b-v1", "nemotron-legacy"],
    ["gpt-5.4-mini", "openai-reasoning"],
    ["minimax/minimax-m3", undefined],
    ["MiniMax-M3", undefined],
    ["openai/gpt-4o-mini", undefined],
    ["meta-llama/llama-3.3-70b-instruct:free", undefined],
  ];

  for (const [model, expected] of cases) {
    it(`${model} resolves to ${expected ?? "no family"}`, () => {
      expect(modelFamilyId(model)).toBe(expected);
    });
  }
});

describe("seeded contracts match the verified vendor documentation", () => {
  it("kimi-k3 accepts low|high|max, defaults to max, and has no disable form", () => {
    const family = modelFamilyFor("moonshotai/kimi-k3")!;
    expect(family.generation).toBe("mandatory");
    expect(family.dialect).toBe("openai-effort");
    expect(family.acceptedEfforts).toEqual(["low", "high", "max"]);
    expect(family.defaultEffort).toBe("max");
    expect(family.disableForm).toBe("none-documented");
    expect(family.acceptedEfforts).not.toContain("medium");
    expect(family.finalTurnPreservation).toBe("required");
    expect(family.omitSampling).toEqual(["temperature"]);
    expect(family.minOutputTokensWithReasoning).toBe(16_000);
  });

  it("kimi-k2.7-code exposes no control at all", () => {
    const family = modelFamilyFor("kimi-k2.7-code")!;
    expect(family.generation).toBe("mandatory");
    expect(family.dialect).toBe("none");
    expect(family.acceptedEfforts).toEqual([]);
    expect(family.finalTurnPreservation).toBe("required");
    expect(family.minOutputTokensWithReasoning).toBe(16_000);
  });

  it("kimi-k2.6 toggles through thinking.type and opts into thinking.keep", () => {
    const family = modelFamilyFor("kimi-k2.6")!;
    expect(family.generation).toBe("default-on");
    expect(family.dialect).toBe("deepseek-thinking");
    expect(family.acceptedEfforts).toEqual([]);
    expect(family.disableForm).toBe("thinking-disabled");
    expect(family.replayOptIn).toBe("kimi-thinking-keep");
    expect(family.omitSampling).toEqual(["temperature"]);
  });

  it("deepseek-v4 is default-on with an effort knob and omits both sampling fields", () => {
    const family = modelFamilyFor("deepseek/deepseek-v4-pro")!;
    expect(family.generation).toBe("default-on");
    expect(family.dialect).toBe("deepseek-thinking");
    expect(family.acceptedEfforts).toEqual(["low", "high", "max"]);
    expect(family.disableForm).toBe("thinking-disabled");
    expect(family.omitSampling).toEqual(["temperature", "top_p"]);
  });

  it("qwen3.8-max accepts low|medium|xhigh and never high", () => {
    const family = modelFamilyFor("qwen/qwen3.8-max")!;
    expect(family.generation).toBe("optional");
    expect(family.dialect).toBe("qwen-enable-thinking");
    expect(family.acceptedEfforts).toEqual(["low", "medium", "xhigh"]);
    expect(family.acceptedEfforts).not.toContain("high");
    expect(family.defaultEffort).toBe("xhigh");
    expect(family.disableForm).toBe("enable-thinking-false");
    expect(family.replayOptIn).toBe("qwen-preserve-thinking");
  });

  it("qwen hybrid routes carry the preserve_thinking opt-in with no effort enum", () => {
    const family = modelFamilyFor("qwen3.7-plus")!;
    expect(family.acceptedEfforts).toEqual([]);
    expect(family.replayOptIn).toBe("qwen-preserve-thinking");
    expect(family.disableForm).toBe("enable-thinking-false");
  });

  it("qwen thinking-only routes cannot be disabled", () => {
    const family = modelFamilyFor("qwen/qwen3-vl-235b-a22b-thinking")!;
    expect(family.generation).toBe("mandatory");
    expect(family.dialect).toBe("none");
    expect(family.disableForm).toBe("none-documented");
  });

  it("openai reasoning models floor at minimal and omit sampling", () => {
    const family = modelFamilyFor("gpt-5.4-mini")!;
    expect(family.dialect).toBe("openai-effort");
    expect(family.acceptedEfforts).toEqual(["minimal", "low", "medium", "high"]);
    expect(family.disableForm).toBe("effort-minimal-floor");
    expect(family.omitSampling).toEqual(["temperature", "top_p"]);
  });

  it("every row declares a non-empty accepted-effort list only when it has a dialect that carries one", () => {
    for (const family of MODEL_FAMILIES) {
      if (family.acceptedEfforts.length === 0) continue;
      expect(family.dialect).not.toBe("none");
    }
  });

  it("every declared default effort is itself an accepted effort", () => {
    for (const family of MODEL_FAMILIES) {
      if (!family.defaultEffort) continue;
      expect(family.acceptedEfforts).toContain(family.defaultEffort);
    }
  });

  it("row ids are unique", () => {
    const ids = MODEL_FAMILIES.map((family) => family.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("provider views stay derived", () => {
  it("keeps the NVIDIA endpoint mapping", () => {
    expect(classifyNvidiaModel("moonshotai/kimi-k2.6")).toBe("kimi-thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-v4");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-r1")).toBe("thinking");
    expect(classifyNvidiaModel("nvidia/llama-3.3-nemotron-super-49b-v1")).toBe("thinking");
    expect(classifyNvidiaModel("nvidia/nemotron-3-nano-30b-a3b")).toBe("nemotron-3");
    expect(classifyNvidiaModel("z-ai/glm-5.1")).toBe("glm-thinking");
    expect(classifyNvidiaModel("google/gemma-4-31b-it")).toBe("enable-thinking");
    expect(classifyNvidiaModel("openai/gpt-oss-120b")).toBe("effort-only");
    expect(classifyNvidiaModel("qwen/qwen3-235b-a22b")).toBe("effort-only");
    expect(classifyNvidiaModel("mistralai/mistral-medium-3.5-128b")).toBe("effort-only");
    expect(classifyNvidiaModel("meta/llama-3.3-70b-instruct")).toBe("none");
  });

  it("keeps the Bynara buckets", () => {
    expect(classifyBynaraModel("kimi-k2.6")).toBe("kimi");
    expect(classifyBynaraModel("deepseek-v4-pro")).toBe("deepseek");
    expect(classifyBynaraModel("agnes-1")).toBe("agnes");
    expect(classifyBynaraModel("stepfun/step-3.7-flash")).toBe("stepfun");
    expect(classifyBynaraModel("mimo-v2.5-free")).toBe("none");
  });
});
