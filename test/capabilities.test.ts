import { beforeEach, describe, expect, it } from "vitest";
import {
  clearModelVisionCapabilities,
  clearReasoningUnsupported,
  effectiveThinkingEffort,
  markReasoningUnsupported,
  modelSupportsThinking,
  modelSupportsVision,
  preferredVisionModel,
  registerModelVisionCapability,
  visionCapabilitySource,
} from "../src/llm/capabilities.js";

beforeEach(() => clearModelVisionCapabilities());

describe("modelSupportsThinking", () => {
  it("recognizes Kimi K2.6 on NVIDIA NIM", () => {
    expect(modelSupportsThinking("nvidia", "moonshotai/kimi-k2.6")).toBe(true);
  });

  it("recognizes DeepSeek R1 on NVIDIA and current Groq reasoning models", () => {
    expect(modelSupportsThinking("nvidia", "deepseek-ai/deepseek-r1")).toBe(true);
    expect(modelSupportsThinking("groq", "qwen/qwen3-32b")).toBe(true);
    expect(modelSupportsThinking("groq", "openai/gpt-oss-20b")).toBe(true);
  });

  it("recognizes GPT-5/o-series on OpenAI", () => {
    expect(modelSupportsThinking("openai", "gpt-5.5")).toBe(true);
    expect(modelSupportsThinking("openai", "o3-mini")).toBe(true);
  });

  it("recognizes MiniMax M3 on Kimchi", () => {
    expect(modelSupportsThinking("kimchi", "minimax-m3")).toBe(true);
    expect(modelSupportsVision("kimchi", "minimax-m3")).toBe(true);
  });

  it("returns false for non-thinking models", () => {
    expect(modelSupportsThinking("openai", "gpt-4o-mini")).toBe(false);
    expect(modelSupportsThinking("groq", "llama-3.3-70b-versatile")).toBe(false);
  });
});

describe("runtime vision capability metadata", () => {
  it("prefers provider-discovered metadata over stale fallback regexes", () => {
    registerModelVisionCapability({
      provider: "openai",
      model: "future-vision-model",
      vision: true,
      source: "provider",
    });
    expect(modelSupportsVision("openai", "future-vision-model")).toBe(true);
    expect(visionCapabilitySource("openai", "future-vision-model")).toBe("provider");
    expect(preferredVisionModel("openai", "text-only-model")).toBe("future-vision-model");
  });

  it("allows a user declaration to override a regex false positive", () => {
    registerModelVisionCapability({
      provider: "openai",
      model: "gpt-4o-mini",
      vision: false,
      source: "user",
    });
    expect(modelSupportsVision("openai", "gpt-4o-mini")).toBe(false);
    expect(visionCapabilitySource("openai", "gpt-4o-mini")).toBe("user");
  });
});
describe("effectiveThinkingEffort", () => {
  it("returns undefined when thinking is disabled or absent", () => {
    expect(effectiveThinkingEffort("openai", "gpt-5.1", undefined)).toBeUndefined();
    expect(
      effectiveThinkingEffort("openai", "gpt-5.1", { enabled: false, effort: "max" }),
    ).toBeUndefined();
  });

  it("returns the configured effort when reasoning is supported", () => {
    expect(
      effectiveThinkingEffort("openai", "gpt-5.1", { enabled: true, effort: "max" }),
    ).toBe("max");
  });

  it("returns undefined after the route is marked reasoning-unsupported", () => {
    markReasoningUnsupported("openai", "gpt-5.1");
    expect(
      effectiveThinkingEffort("openai", "gpt-5.1", { enabled: true, effort: "max" }),
    ).toBeUndefined();
    clearReasoningUnsupported();
  });
});
