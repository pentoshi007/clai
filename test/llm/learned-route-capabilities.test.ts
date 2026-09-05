import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLearnedRouteCapabilities,
  isReasoningUnsupported,
  learnRouteAcceptedEfforts,
  learnRouteRejectedField,
  learnedRouteRejectedFields,
  markReasoningUnsupported,
  modelReasoningEfforts,
  reloadLearnedCapabilities,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { clearControlRejections } from "../../src/llm/provider-profile.js";
import { getConfig, updateConfig } from "../../src/store/config.js";

const PROVIDER = "tokenrouter";
const MODEL = "vendor/persistence-probe";
const KEY = `${PROVIDER}:${MODEL}`;

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function reload(): void {
  resetReasoningKnowledge();
  clearControlRejections();
  reloadLearnedCapabilities();
}

beforeEach(() => {
  clearLearnedRouteCapabilities();
  resetReasoningKnowledge();
  clearControlRejections();
});

afterEach(() => {
  clearLearnedRouteCapabilities();
  resetReasoningKnowledge();
});

describe("learned route capabilities persist positives only", () => {
  it("keeps a reasoning rejection session-scoped instead of persisting it", () => {
    markReasoningUnsupported(PROVIDER, MODEL);
    expect(isReasoningUnsupported(PROVIDER, MODEL)).toBe(true);
    expect(getConfig().learnedRouteCapabilities?.[KEY]?.reasoning).toBeUndefined();
    expect(
      getConfig().learnedRouteCapabilities?.[KEY]?.controlDialect,
    ).toBeUndefined();
    reload();
    expect(
      resolveBuiltInProfile({ provider: PROVIDER, model: MODEL }).reasoning.control
        .status,
    ).not.toBe("unsupported");
  });

  it("ignores and scrubs a legacy persisted negative, however fresh", () => {
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: {
          reasoning: false,
          controlDialect: "openai-effort",
          at: new Date().toISOString(),
        },
      },
    });
    reload();
    expect(
      resolveBuiltInProfile({ provider: PROVIDER, model: MODEL }).reasoning.control
        .status,
    ).not.toBe("unsupported");
    expect(getConfig().learnedRouteCapabilities?.[KEY]?.reasoning).toBeUndefined();
  });

  it("keeps learned accepted efforts across a reload and surfaces them on the profile", () => {
    learnRouteAcceptedEfforts(PROVIDER, MODEL, ["Low", "high", "max"]);
    reload();
    expect(modelReasoningEfforts(PROVIDER, MODEL)).toEqual(["low", "high", "max"]);
    expect(
      resolveBuiltInProfile({ provider: PROVIDER, model: MODEL }).reasoning.acceptedEfforts,
    ).toEqual(["low", "high", "max"]);
  });

  it("keeps a positive fact even when it is older than the negative window", () => {
    learnRouteAcceptedEfforts(PROVIDER, MODEL, ["low", "high"]);
    const stored = getConfig().learnedRouteCapabilities?.[KEY];
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: {
          ...stored!,
          at: new Date(Date.now() - FOURTEEN_DAYS_MS - 60_000).toISOString(),
        },
      },
    });
    reload();
    expect(modelReasoningEfforts(PROVIDER, MODEL)).toEqual(["low", "high"]);
  });

  it("remembers rejected fields for the session and forgets them on reset", () => {
    learnRouteRejectedField(PROVIDER, MODEL, "Reasoning_Effort");
    expect(learnedRouteRejectedFields(PROVIDER, MODEL)).toEqual(["reasoning_effort"]);
    expect(learnedRouteRejectedFields(PROVIDER, "other-model")).toEqual([]);
    expect(
      getConfig().learnedRouteCapabilities?.[KEY]?.rejectedFields,
    ).toBeUndefined();
    resetReasoningKnowledge();
    expect(learnedRouteRejectedFields(PROVIDER, MODEL)).toEqual([]);
  });

  it("keys session rejected fields consistently for free-N/ model aliases", () => {
    learnRouteRejectedField(PROVIDER, "free-3/alias-probe", "Reasoning_Effort");
    expect(learnedRouteRejectedFields(PROVIDER, "free-3/alias-probe")).toEqual([
      "reasoning_effort",
    ]);
    expect(learnedRouteRejectedFields(PROVIDER, "alias-probe")).toEqual([
      "reasoning_effort",
    ]);
    resetReasoningKnowledge();
    learnRouteRejectedField(PROVIDER, "alias-probe", "reasoning");
    expect(learnedRouteRejectedFields(PROVIDER, "free-7/alias-probe")).toEqual([
      "reasoning",
    ]);
  });

  it("migrates an existing learned vision entry forward without dropping it", () => {
    updateConfig({
      learnedVisionCapabilities: { [KEY]: { vision: true, at: new Date().toISOString() } },
    });
    reload();
    expect(getConfig().learnedVisionCapabilities[KEY]).toBeDefined();
  });
});
