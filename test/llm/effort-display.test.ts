import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLearnedRouteCapabilities,
  effectiveThinkingEffort,
  isReasoningUnsupported,
  markReasoningUnsupported,
  registerRouteControlDialect,
  reloadLearnedCapabilities,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import { publishRouteReasoningVocabulary } from "../../src/llm/route-vocabulary.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { emitReasoningControls } from "../../src/llm/reasoning-controls.js";

const ROUTES = [
  { provider: "tokenrouter", model: "qwen/qwen3.8-max-free" },
  { provider: "bynara", model: "qwen-3.8-max-free" },
  { provider: "openai", model: "gpt-5.4-mini" },
  { provider: "tokenrouter", model: "moonshotai/kimi-k3" },
  { provider: "fireworks", model: "accounts/fireworks/models/qwen3p8-max" },
] as const;

function wireEffort(provider: string, model: string, effort: "xhigh"): string | undefined {
  const emitted = emitReasoningControls({
    profile: resolveBuiltInProfile({ provider: provider as never, model }),
    preference: { enabled: true, effort },
    model,
    willReplayReasoning: false,
  }) as { reasoning_effort?: string };
  return emitted.reasoning_effort;
}

describe("the effort shown is the effort sent", () => {
  beforeEach(() => {
    resetReasoningKnowledge();
  });

  for (const route of ROUTES) {
    it(`${route.provider} ${route.model} displays what the wire carries`, () => {
      publishRouteReasoningVocabulary(route.provider as never, route.model);
      const shown = effectiveThinkingEffort(route.provider as never, route.model, {
        enabled: true,
        effort: "xhigh",
      });
      expect(shown).toBe(wireEffort(route.provider, route.model, "xhigh"));
    });
  }

  it("degrades a stale preference when the route cannot serve it", () => {
    publishRouteReasoningVocabulary("tokenrouter" as never, "qwen/qwen3.8-max-free");
    expect(
      effectiveThinkingEffort("tokenrouter" as never, "qwen/qwen3.8-max-free", {
        enabled: true,
        effort: "xhigh",
      }),
    ).toBe("medium");
  });

  it("keeps the preference when the route accepts it", () => {
    publishRouteReasoningVocabulary("fireworks" as never, "accounts/fireworks/models/qwen3p8-max");
    expect(
      effectiveThinkingEffort(
        "fireworks" as never,
        "accounts/fireworks/models/qwen3p8-max",
        { enabled: true, effort: "xhigh" },
      ),
    ).toBe("xhigh");
  });

  it("reports nothing when thinking is off", () => {
    expect(
      effectiveThinkingEffort("openai" as never, "gpt-5.4-mini", {
        enabled: false,
        effort: "high",
      }),
    ).toBeUndefined();
  });
});

describe("a negative learned under a superseded dialect does not stick", () => {
  beforeEach(() => {
    resetReasoningKnowledge();
  });

  it("discards the rejection once the route's dialect changes", () => {
    const provider = "fireworks" as never;
    const model = "accounts/fireworks/models/qwen3p8-max";
    registerRouteControlDialect(provider, model, "qwen-enable-thinking");
    markReasoningUnsupported(provider, model);
    expect(isReasoningUnsupported(provider, model)).toBe(true);
    publishRouteReasoningVocabulary(provider, model);
    expect(isReasoningUnsupported(provider, model)).toBe(false);
  });

  it("honours a rejection learned under the dialect still in force", () => {
    const provider = "ollama" as never;
    const model = "llama3.1:8b";
    publishRouteReasoningVocabulary(provider, model);
    markReasoningUnsupported(provider, model);
    expect(isReasoningUnsupported(provider, model)).toBe(true);
  });
});

describe("a persisted negative without provenance is not trusted", () => {
  const KEY = "fireworks:accounts/fireworks/models/qwen3p8-max";
  const provider = "fireworks" as never;
  const model = "accounts/fireworks/models/qwen3p8-max";

  beforeEach(() => {
    resetReasoningKnowledge();
    clearLearnedRouteCapabilities();
  });

  afterEach(() => {
    clearLearnedRouteCapabilities();
    resetReasoningKnowledge();
  });

  it("ignores a fresh negative that records no control dialect", () => {
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: { reasoning: false, at: new Date().toISOString() },
      },
    });
    reloadLearnedCapabilities();
    publishRouteReasoningVocabulary(provider, model);
    expect(isReasoningUnsupported(provider, model)).toBe(false);
    expect(
      effectiveThinkingEffort(provider, model, { enabled: true, effort: "xhigh" }),
    ).toBe("xhigh");
  });

  it("prunes the untrusted negative from the config so it cannot come back", () => {
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: { reasoning: false, at: new Date().toISOString() },
      },
    });
    reloadLearnedCapabilities();
    expect(getConfig().learnedRouteCapabilities?.[KEY]?.reasoning).toBeUndefined();
  });

  it("records provenance for every new rejection", () => {
    publishRouteReasoningVocabulary(provider, model);
    markReasoningUnsupported(provider, model);
    expect(getConfig().learnedRouteCapabilities?.[KEY]?.controlDialect).toBeTruthy();
  });
});

describe("a route that never returns reasoning reports no effort", () => {
  beforeEach(() => {
    resetReasoningKnowledge();
  });

  it("shows nothing for bynara ling, which emits no reasoning under any control", () => {
    publishRouteReasoningVocabulary("bynara" as never, "ling-3.0-flash-free");
    expect(
      effectiveThinkingEffort("bynara" as never, "ling-3.0-flash-free", {
        enabled: true,
        effort: "high",
      }),
    ).toBeUndefined();
  });

  it("keeps reporting an effort for a bynara route that does reason", () => {
    publishRouteReasoningVocabulary("bynara" as never, "qwen-3.8-max-free");
    expect(
      effectiveThinkingEffort("bynara" as never, "qwen-3.8-max-free", {
        enabled: true,
        effort: "high",
      }),
    ).toBe("medium");
  });
});
