import { beforeEach, describe, expect, it } from "vitest";

import {
  activeControlRejections,
  applyObservedControlRejections,
  clearControlRejections,
  DEFAULT_CONTROL_REJECTION_TTL_MS,
  isControlRejected,
  profileSummary,
  recordControlRejection,
  resolveProviderProfile,
  type ProviderProfileLayer,
} from "../../src/llm/provider-profile.js";

const builtinEvidence = { source: "builtin", confidence: "exact" } as const;
const userEvidence = { source: "user-config", confidence: "exact" } as const;

const builtinLayer: ProviderProfileLayer = {
  evidence: builtinEvidence,
  reasoning: {
    generation: "default-on",
    control: {
      dialect: "openai-effort",
      status: "supported",
      evidence: builtinEvidence,
    },
    acceptedEfforts: ["low", "high"],
    outputShapes: ["reasoning-content"],
  },
  limits: { contextTokens: 128_000, outputTokens: 8_192, source: "provider-doc" },
  terminal: { proofs: ["done-sentinel", "finish-reason"] },
};

beforeEach(() => {
  clearControlRejections();
});

describe("conservative unknown profile", () => {
  it("sends no optional control while parsing every known output shape", () => {
    const profile = resolveProviderProfile({
      provider: "custom",
      model: "mystery-model",
    });
    expect(profile.reasoning.control.dialect).toBe("none");
    expect(profile.reasoning.control.status).toBe("unknown");
    expect(profile.reasoning.disable).toBe("unknown");
    expect(profile.capabilities).toEqual({
      tools: "unknown",
      images: "unknown",
      structuredOutput: "unknown",
      streamOptions: "unknown",
    });
    expect(profile.reasoning.outputShapes).toContain("reasoning-content");
    expect(profile.reasoning.outputShapes).toContain("structured-details");
    expect(profile.terminal.naturalEofAccepted).toBe(false);
    expect(profile.limits.source).toBe("unknown");
    expect(profile.cache.kind).toBe("unknown");
  });
});

describe("emits reasoning but rejects the control", () => {
  it("downgrades only the control facet, never generation or parsing", () => {
    recordControlRejection({
      provider: "tokenrouter",
      model: "unknown-reasoner",
      field: "reasoning_effort",
      value: "none",
    });
    const profile = applyObservedControlRejections(
      resolveProviderProfile({
        provider: "tokenrouter",
        model: "unknown-reasoner",
        layers: {
          observed: {
            evidence: { source: "observed", confidence: "exact" },
            reasoning: { generation: "default-on" },
          },
        },
      }),
    );
    expect(profile.reasoning.generation).toBe("default-on");
    expect(profile.reasoning.generationEvidence.source).toBe("observed");
    expect(profile.reasoning.control.status).toBe("unsupported");
    expect(profile.reasoning.control.evidence.source).toBe("observed");
    expect(profile.reasoning.control.evidence.detail).toBe(
      "rejected reasoning_effort=none",
    );
    expect(profile.reasoning.outputShapes.length).toBeGreaterThan(0);
  });
});

describe("mandatory reasoning with unsupported disable", () => {
  it("represents both facts independently", () => {
    const profile = resolveProviderProfile({
      provider: "bynara",
      model: "kimi-k3",
      layers: {
        builtin: {
          evidence: builtinEvidence,
          reasoning: {
            generation: "mandatory",
            control: {
              dialect: "none",
              status: "unsupported",
              evidence: builtinEvidence,
            },
            replayScope: "all-history",
            finalTurnPreservation: "required",
          },
        },
      },
    });
    expect(profile.reasoning.generation).toBe("mandatory");
    expect(profile.reasoning.disable).toBe("unsupported");
    expect(profile.reasoning.disableForm).toBe("none-documented");
    expect(profile.reasoning.replayScope).toBe("all-history");
    expect(profile.reasoning.finalTurnPreservation).toBe("required");
  });
});

describe("evidence retention", () => {
  it("records the defining source per facet and for the profile", () => {
    const profile = resolveProviderProfile({
      provider: "openai",
      model: "gpt-test",
      layers: {
        userConfig: {
          evidence: userEvidence,
          limits: { contextTokens: 10_000, source: "user-config" },
        },
        builtin: builtinLayer,
      },
    });
    expect(profile.evidence.source).toBe("user-config");
    expect(profile.limits.contextTokens).toBe(10_000);
    expect(profile.limits.source).toBe("user-config");
    expect(profile.reasoning.generationEvidence.source).toBe("builtin");
    expect(profile.reasoning.control.evidence.source).toBe("builtin");
    expect(profile.terminal.evidence.source).toBe("builtin");
  });

  it("keeps a metadata-only summary without raw payloads", () => {
    const summary = profileSummary(
      resolveProviderProfile({
        provider: "openai",
        model: "gpt-test",
        layers: { builtin: builtinLayer },
      }),
    );
    expect(summary.reasoning.controlDialect).toBe("openai-effort");
    expect(summary.reasoning.generation).toBe("default-on");
    expect(summary.reasoning.evidenceSources).toContain("builtin");
    expect(JSON.stringify(summary)).not.toContain("prompt");
    expect(JSON.stringify(summary)).not.toContain("signature");
  });
});

describe("layer precedence", () => {
  it("user config overrides builtin, builtin overrides family", () => {
    const profile = resolveProviderProfile({
      provider: "nvidia",
      model: "deepseek-v4",
      layers: {
        userConfig: {
          evidence: userEvidence,
          capabilities: { tools: "unsupported" },
        },
        builtin: {
          evidence: builtinEvidence,
          capabilities: { tools: "supported" },
          limits: { contextTokens: 1_000_000, source: "provider-doc" },
        },
        family: {
          evidence: { source: "family", confidence: "inferred" },
          limits: { contextTokens: 128_000, source: "family-default" },
        },
      },
    });
    expect(profile.capabilities.tools).toBe("unsupported");
    expect(profile.limits.contextTokens).toBe(1_000_000);
    expect(profile.limits.source).toBe("provider-doc");
  });

  it("observed output evidence is used when no declaration exists", () => {
    const profile = resolveProviderProfile({
      provider: "free",
      model: "dynamic-model",
      layers: {
        observed: {
          evidence: { source: "observed", confidence: "high" },
          reasoning: { generation: "default-on" },
        },
      },
    });
    expect(profile.reasoning.generation).toBe("default-on");
    expect(profile.evidence.source).toBe("observed");
  });
});

describe("scoped control rejections", () => {
  const base = {
    provider: "nvidia",
    model: "deepseek-v4",
    field: "reasoning_effort",
    value: "none",
  };

  it("scopes by endpoint, credential, config generation, model, and field", () => {
    const now = 1_000_000;
    recordControlRejection(base, { now });
    expect(isControlRejected(base, now)).toBe(true);
    expect(
      isControlRejected(
        { ...base, endpointHash: "sha256:other-endpoint" },
        now,
      ),
    ).toBe(false);
    expect(
      isControlRejected({ ...base, credentialHash: "sha256:key-2" }, now),
    ).toBe(false);
    expect(
      isControlRejected({ ...base, configGeneration: "config-v2" }, now),
    ).toBe(false);
    expect(isControlRejected({ ...base, model: "deepseek-v3" }, now)).toBe(
      false,
    );
    expect(isControlRejected({ ...base, field: "thinking" }, now)).toBe(false);
    expect(isControlRejected({ ...base, value: "low" }, now)).toBe(false);
  });

  it("expires after the TTL", () => {
    const now = 1_000_000;
    recordControlRejection(base, { now });
    expect(isControlRejected(base, now + DEFAULT_CONTROL_REJECTION_TTL_MS - 1)).toBe(true);
    expect(isControlRejected(base, now + DEFAULT_CONTROL_REJECTION_TTL_MS)).toBe(
      false,
    );
    expect(activeControlRejections(base, now + DEFAULT_CONTROL_REJECTION_TTL_MS)).toHaveLength(0);
  });
});
