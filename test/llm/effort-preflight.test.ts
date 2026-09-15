import { afterEach, describe, expect, it } from "vitest";

import {
  clearReasoningUnsupported,
  clearReasoningRejection,
  displayReasoningEfforts,
  effectiveThinkingEffort,
  markReasoningUnsupported,
  registerModelReasoningSupport,
  registerRouteAcceptedEfforts,
  registerWireRejectionEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import {
  effortPreflightKey,
  needsEffortPreflight,
  resetEffortPreflightForTesting,
  runEffortPreflight,
  type EffortPreflightRoute,
  type EffortProbeOutcome,
} from "../../src/llm/wire/effort-preflight.js";
import type { ReasoningEffort } from "../../src/types.js";

const PROVIDER = "bynara";
const MODEL = "glm-5.3";

const FULL_SCALE: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function route(overrides: Partial<EffortPreflightRoute> = {}): EffortPreflightRoute {
  registerModelReasoningSupport(PROVIDER, MODEL, true);
  return {
    providerId: PROVIDER,
    model: MODEL,
    endpoint: "https://gateway.test/v1/",
    requested: "max",
    purpose: "turn",
    ...overrides,
  };
}

function prober(accepts: readonly ReasoningEffort[], aborts: readonly ReasoningEffort[] = []) {
  const seen: ReasoningEffort[] = [];
  const probe = async (effort: ReasoningEffort): Promise<EffortProbeOutcome> => {
    seen.push(effort);
    if (aborts.includes(effort)) return "abort";
    return accepts.includes(effort) ? "accepted" : "unsupported";
  };
  return { seen, probe };
}

function inSession<T>(session: string, run: () => Promise<T>): Promise<T> {
  return withSessionAffinity(session, run);
}

afterEach(() => {
  resetEffortPreflightForTesting();
  clearReasoningUnsupported();
  resetReasoningKnowledge();
});

describe("session-scoped effort preflight", () => {
  it("probes max first and stops at the first accepted effort", async () => {
    const { seen, probe } = prober(["max"]);
    await runEffortPreflight(route(), probe);
    expect(seen).toEqual(["max"]);
    expect(displayReasoningEfforts(PROVIDER, MODEL)).toEqual(FULL_SCALE);
  });

  it("climbs down the ladder until the route accepts an effort", async () => {
    const { seen, probe } = prober(["high"]);
    await runEffortPreflight(route(), probe);
    expect(seen).toEqual(["max", "xhigh", "high"]);
    expect(displayReasoningEfforts(PROVIDER, MODEL)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("never probes a route whose vocabulary is already known", async () => {
    registerRouteAcceptedEfforts(PROVIDER, MODEL, ["low", "high", "max"]);
    for (const requested of ["medium", "xhigh", "none"] as const) {
      const { seen, probe } = prober(["high"]);
      const target = route({ requested });
      expect(needsEffortPreflight(target)).toBe(false);
      await runEffortPreflight(target, probe);
      expect(seen).toEqual([]);
    }
    expect(displayReasoningEfforts(PROVIDER, MODEL)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("climbs from none for subagent probes and settles the accepted floor", async () => {
    const { seen, probe } = prober(["low"]);
    await inSession("parent-1:subagent:alpha", async () => {
      await runEffortPreflight(route({ requested: "none", purpose: undefined }), probe);
      expect(displayReasoningEfforts(PROVIDER, MODEL)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    });
    expect(seen).toEqual(["none", "low"]);
    expect(displayReasoningEfforts(PROVIDER, MODEL)).toBeUndefined();
  });

  it("never probes compaction or auxiliary requests", async () => {
    for (const purpose of ["compaction", "auxiliary"] as const) {
      const { seen, probe } = prober(["max"]);
      const target = route({ purpose });
      expect(needsEffortPreflight(target)).toBe(false);
      await runEffortPreflight(target, probe);
      expect(seen).toEqual([]);
    }
  });

  it("skips a route already known to reject reasoning", async () => {
    markReasoningUnsupported(PROVIDER, MODEL);
    expect(needsEffortPreflight(route())).toBe(false);
  });

  it("probes once per session per route and selected effort", async () => {
    const first = prober(["high"]);
    await inSession("session-a", () => runEffortPreflight(route(), first.probe));
    expect(first.seen).toEqual(["max", "xhigh", "high"]);

    const repeat = prober(["high"]);
    await inSession("session-a", () => runEffortPreflight(route(), repeat.probe));
    expect(repeat.seen).toEqual([]);

    const otherSession = prober(["high"]);
    await inSession("session-b", () => runEffortPreflight(route(), otherSession.probe));
    expect(otherSession.seen).toEqual([]);
  });

  it("re-probes when the selected effort changes and the vocabulary is still unknown", async () => {
    const aborted = prober([], ["max"]);
    await inSession("session-a", () => runEffortPreflight(route(), aborted.probe));
    expect(aborted.seen).toEqual(["max"]);

    const changed = prober(["high"]);
    await inSession("session-a", () =>
      runEffortPreflight(route({ requested: "low" }), changed.probe),
    );
    expect(changed.seen).toEqual(["max", "xhigh", "high"]);
  });

  it("keys the probe by endpoint without its trailing slash", async () => {
    const slashed = effortPreflightKey(route({ endpoint: "https://gateway.test/v1" }));
    const plain = effortPreflightKey(route({ endpoint: "https://gateway.test/v1///" }));
    expect(plain).toBe(slashed);
  });

  it("shares one subagent probe across every child of the same conversation", async () => {
    const childRoute = route({ requested: "none", purpose: undefined });
    let parentKey = "";
    await inSession("parent-1:subagent:alpha", async () => {
      parentKey = effortPreflightKey(childRoute);
      await runEffortPreflight(childRoute, prober(["low"]).probe);
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "none" })).toBe("low");
    });

    const beta = prober(["low"]);
    let siblingKey = "";
    await inSession("parent-1:subagent:beta", async () => {
      siblingKey = effortPreflightKey(childRoute);
      await runEffortPreflight(childRoute, beta.probe);
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "none" })).toBe("low");
    });

    expect(siblingKey).toBe(parentKey);
    expect(beta.seen).toEqual([]);
    await inSession("parent-1:subagent:alpha", async () => {
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "none" })).toBe("low");
    });
  });

  it("keeps child rejection and accepted-effort learning out of parent and sibling scopes", async () => {
    const childRoute = route({ requested: "none", purpose: undefined });
    await inSession("parent-2:subagent:alpha", async () => {
      await runEffortPreflight(childRoute, prober(["low"]).probe);
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" })).toBe("max");
      markReasoningUnsupported(PROVIDER, MODEL);
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" })).toBeUndefined();
    });

    expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" })).toBe("max");
    await inSession("parent-2:subagent:beta", async () => {
      expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" })).toBe("max");
    });
  });

  it("does not let later parent learning change an active child's runtime baseline", async () => {
    registerModelReasoningSupport(PROVIDER, MODEL, true);
    registerRouteAcceptedEfforts(PROVIDER, MODEL, FULL_SCALE);
    const child = "baseline-parent:subagent:one";
    const requested = { enabled: true, effort: "max" as const };
    expect(withSessionAffinity(child, () => effectiveThinkingEffort(PROVIDER, MODEL, requested))).toBe("max");
    registerWireRejectionEfforts(PROVIDER, MODEL, ["low"]);
    markReasoningUnsupported(PROVIDER, MODEL);
    expect(effectiveThinkingEffort(PROVIDER, MODEL, requested)).toBeUndefined();
    expect(withSessionAffinity(child, () => effectiveThinkingEffort(PROVIDER, MODEL, requested))).toBe("max");
    withSessionAffinity(child, () => clearReasoningRejection(PROVIDER, MODEL));
    expect(effectiveThinkingEffort(PROVIDER, MODEL, requested)).toBeUndefined();
  });

  it("keeps clearing a fresh child's rejection and auxiliary learning local", async () => {
    registerModelReasoningSupport(PROVIDER, MODEL, true);
    markReasoningUnsupported(PROVIDER, MODEL);
    const child = "clear-parent:subagent:one";
    withSessionAffinity(child, () => clearReasoningRejection(PROVIDER, MODEL));
    expect(effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" })).toBeUndefined();
    expect(withSessionAffinity(child, () => effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" }))).toBe("max");
    withSessionAffinity(`${child}:auxiliary`, () => markReasoningUnsupported(PROVIDER, MODEL));
    expect(withSessionAffinity(child, () => effectiveThinkingEffort(PROVIDER, MODEL, { enabled: true, effort: "max" }))).toBe("max");
  });

  it("keeps turn and subagent probes independent", async () => {
    const turn = prober(["max"]);
    await inSession("session-c", () => runEffortPreflight(route(), turn.probe));
    const child = prober(["none"]);
    await inSession("session-c", () =>
      runEffortPreflight(route({ requested: "none", purpose: undefined }), child.probe),
    );
    expect(turn.seen).toEqual(["max"]);
    expect(child.seen).toEqual([]);
  });

  it("dedupes concurrent probes for the same route", async () => {
    const { seen, probe } = prober(["max"]);
    await Promise.all([
      runEffortPreflight(route(), probe),
      runEffortPreflight(route(), probe),
    ]);
    expect(seen).toEqual(["max"]);
  });

  it("remembers an aborted ladder so the next turn does not re-probe", async () => {
    const { seen, probe } = prober([], ["max"]);
    await runEffortPreflight(route(), probe);
    expect(seen).toEqual(["max"]);
    expect(displayReasoningEfforts(PROVIDER, MODEL)).toBeUndefined();
    expect(needsEffortPreflight(route())).toBe(false);
  });
});
