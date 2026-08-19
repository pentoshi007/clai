import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLearnedRouteCapabilities,
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

describe("learned route capabilities survive a restart", () => {
  it("keeps a reasoning rejection across a config reload", () => {
    markReasoningUnsupported(PROVIDER, MODEL);
    expect(getConfig().learnedRouteCapabilities?.[KEY]?.reasoning).toBe(false);
    reload();
    expect(resolveBuiltInProfile({ provider: PROVIDER, model: MODEL }).reasoning.control.status).toBe(
      "unsupported",
    );
  });

  it("ignores a negative older than the fourteen-day window", () => {
    markReasoningUnsupported(PROVIDER, MODEL);
    const stored = getConfig().learnedRouteCapabilities?.[KEY];
    expect(stored).toBeDefined();
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: {
          ...stored!,
          at: new Date(Date.now() - FOURTEEN_DAYS_MS - 60_000).toISOString(),
        },
      },
    });
    reload();
    expect(resolveBuiltInProfile({ provider: PROVIDER, model: MODEL }).reasoning.control.status).not.toBe(
      "unsupported",
    );
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

  it("records rejected fields per route and expires them with the negative window", () => {
    learnRouteRejectedField(PROVIDER, MODEL, "Reasoning_Effort");
    expect(learnedRouteRejectedFields(PROVIDER, MODEL)).toEqual(["reasoning_effort"]);
    expect(learnedRouteRejectedFields(PROVIDER, "other-model")).toEqual([]);
    const stored = getConfig().learnedRouteCapabilities?.[KEY];
    updateConfig({
      learnedRouteCapabilities: {
        [KEY]: {
          ...stored!,
          at: new Date(Date.now() - FOURTEEN_DAYS_MS - 60_000).toISOString(),
        },
      },
    });
    expect(learnedRouteRejectedFields(PROVIDER, MODEL)).toEqual([]);
  });

  it("migrates an existing learned vision entry forward without dropping it", () => {
    updateConfig({
      learnedVisionCapabilities: { [KEY]: { vision: true, at: new Date().toISOString() } },
    });
    reload();
    expect(getConfig().learnedVisionCapabilities[KEY]).toBeDefined();
  });
});
