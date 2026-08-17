import { describe, expect, it } from "vitest";

import {
  customReasoningStyle,
  endpointPrivacyHash,
  resolveCustomProviderProfile,
  validateCustomProviderProfile,
} from "../../src/llm/custom-provider-profile.js";

describe("custom profile validation", () => {
  it("accepts a complete valid declaration", () => {
    const { spec, errors } = validateCustomProviderProfile({
      authType: "bearer",
      keyEnv: "MY_GATEWAY_KEY",
      baseUrlEnv: "MY_GATEWAY_URL",
      tools: "supported",
      images: "unsupported",
      streamOptions: "supported",
      reasoning: {
        generation: "optional",
        controlDialect: "openai-effort",
        acceptedEfforts: ["low", "high"],
        disable: "supported",
        disableForm: "omit-control",
        outputShapes: ["reasoning-content", "structured-details"],
        replayScope: "tool-turn",
      },
      limits: { contextTokens: 200_000, outputTokens: 16_384, source: "provider-doc" },
      cache: { kind: "affinity-key", affinityField: "session_key" },
      usage: { cachedInput: ["usage.cache_read"] },
      terminal: { naturalEofAccepted: false },
    });
    expect(errors).toEqual([]);
    expect(spec?.reasoning?.controlDialect).toBe("openai-effort");
    expect(spec?.limits?.contextTokens).toBe(200_000);
  });

  it("rejects unknown fields with the allowed list", () => {
    const { errors } = validateCustomProviderProfile({ toolz: "supported" });
    expect(errors.join("\n")).toContain('unknown profile field "toolz"');
  });

  it("rejects keyless combined with keyEnv", () => {
    const { errors } = validateCustomProviderProfile({
      authType: "none-keyless",
      keyEnv: "KEY",
    });
    expect(errors.join("\n")).toContain("none-keyless");
  });

  it("rejects unsupported auth types with an actionable message", () => {
    const { errors } = validateCustomProviderProfile({ authType: "query" });
    expect(errors.join("\n")).toContain("query auth is not supported yet");
  });

  it("rejects mandatory reasoning with a disable declaration", () => {
    const { errors } = validateCustomProviderProfile({
      reasoning: { generation: "mandatory", disable: "supported", disableForm: "effort-none" },
    });
    expect(errors.join("\n")).toContain("mandatory reasoning cannot declare disable");
  });

  it("requires a disable form when disable is declared supported", () => {
    const { errors } = validateCustomProviderProfile({
      reasoning: { controlDialect: "openai-effort", disable: "supported" },
    });
    expect(errors.join("\n")).toContain("requires a disableForm");
  });

  it("rejects control dialects the custom serializer cannot emit", () => {
    const { errors } = validateCustomProviderProfile({
      reasoning: { controlDialect: "deepseek-thinking" },
    });
    expect(errors.join("\n")).toContain("not serializable on custom routes yet");
  });

  it("rejects malformed limits and enum values", () => {
    const { errors } = validateCustomProviderProfile({
      limits: { contextTokens: -5 },
      tools: "maybe",
    });
    expect(errors.join("\n")).toContain("contextTokens must be a positive integer");
    expect(errors.join("\n")).toContain("tools must be supported | unsupported | unknown");
  });
});

describe("custom profile resolution", () => {
  it("undeclared routes resolve conservative unknown with strict EOF", () => {
    const profile = resolveCustomProviderProfile({
      id: "myllm",
      model: "some-model",
      baseUrl: "https://api.example.com/v1",
    });
    expect(profile.route.provider).toBe("myllm");
    expect(profile.route.endpointHash).toBe(
      endpointPrivacyHash("https://api.example.com/v1"),
    );
    expect(profile.reasoning.control.dialect).toBe("none");
    expect(profile.reasoning.control.status).toBe("unknown");
    expect(profile.terminal.naturalEofAccepted).toBe(false);
    expect(profile.evidence.source).toBe("default");
  });

  it("declarations win as user-config evidence", () => {
    const profile = resolveCustomProviderProfile({
      id: "myllm",
      model: "some-model",
      baseUrl: "https://api.example.com/v1",
      profile: {
        tools: "supported",
        reasoning: { controlDialect: "openai-effort" },
        limits: { contextTokens: 64_000 },
      },
    });
    expect(profile.reasoning.control.dialect).toBe("openai-effort");
    expect(profile.reasoning.control.status).toBe("supported");
    expect(profile.reasoning.control.evidence.source).toBe("user-config");
    expect(profile.limits.contextTokens).toBe(64_000);
    expect(profile.limits.source).toBe("user-config");
    expect(profile.evidence.source).toBe("user-config");
  });

  it("a direct DeepSeek endpoint earns the documented V4 route layer", () => {
    const profile = resolveCustomProviderProfile({
      id: "direct-ds",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(profile.reasoning.control.dialect).toBe("deepseek-thinking");
    expect(profile.reasoning.disableForm).toBe("thinking-disabled");
    expect(profile.limits.contextTokens).toBe(1_000_000);
    expect(profile.limits.outputTokens).toBe(384_000);
    expect(profile.usage.cachedInput).toContain("usage.prompt_cache_hit_tokens");
  });

  it("user declarations still outrank the direct DeepSeek route layer", () => {
    const profile = resolveCustomProviderProfile({
      id: "direct-ds",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      profile: { limits: { contextTokens: 128_000 } },
    });
    expect(profile.reasoning.control.dialect).toBe("deepseek-thinking");
    expect(profile.limits.contextTokens).toBe(128_000);
    expect(profile.limits.source).toBe("user-config");
  });

  it("a DeepSeek model on a non-DeepSeek host gets no upstream fields", () => {
    const profile = resolveCustomProviderProfile({
      id: "gateway",
      model: "deepseek-v4-pro",
      baseUrl: "https://gw.example.com/v1",
    });
    expect(profile.reasoning.control.dialect).toBe("none");
    expect(profile.reasoning.control.status).toBe("unknown");
  });
});

describe("serializer style", () => {
  it("undeclared and none dialects omit optional reasoning controls", () => {
    expect(customReasoningStyle(undefined)).toBe("none");
    expect(
      customReasoningStyle({ reasoning: { controlDialect: "none" } }),
    ).toBe("none");
  });

  it("declared effort dialect maps to the compatible serializer", () => {
    expect(
      customReasoningStyle({ reasoning: { controlDialect: "openai-effort" } }),
    ).toBe("openai");
  });
});
