import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/llm/http.js";
import {
  DEFAULT_STREAM_RECOVERY_LIMITS,
  classifyStreamFailure,
  createStreamRecoveryState,
  planStreamRecovery,
  recordRecoveryAttempt,
  resetStreamRecoveryState,
  type StreamFailureKind,
} from "../src/agent/stream-recovery.js";

describe("classifyStreamFailure", () => {
  it("classifies empty admissions (raw and router-wrapped)", () => {
    expect(
      classifyStreamFailure(
        new ProviderError("bynara completed without a visible answer."),
      ),
    ).toBe("empty");
    expect(
      classifyStreamFailure(
        new Error(
          "No provider could stream the request. — bynara: bynara completed without a visible answer.",
        ),
      ),
    ).toBe("empty");
  });

  it("classifies rate limits by status and message", () => {
    expect(classifyStreamFailure(new ProviderError("slow down", 429))).toBe(
      "rate-limit",
    );
    expect(
      classifyStreamFailure(new Error("nvidia: Model is rate limited (429)")),
    ).toBe("rate-limit");
  });

  it("classifies context overflow by status and message", () => {
    expect(classifyStreamFailure(new ProviderError("too big", 413))).toBe(
      "context-overflow",
    );
    expect(
      classifyStreamFailure(
        new Error("Request exceeded the provider input limit (413)."),
      ),
    ).toBe("context-overflow");
  });

  it("classifies upstream 5xx as server", () => {
    expect(classifyStreamFailure(new ProviderError("bad gateway", 503))).toBe(
      "server",
    );
  });

  it("classifies connection glitches as network", () => {
    expect(
      classifyStreamFailure(new Error("bynara connection glitch")),
    ).toBe("network");
    expect(
      classifyStreamFailure(
        new Error("socket connection was closed unexpectedly"),
      ),
    ).toBe("network");
  });

  it("separates a live-connection stall from a transport failure", () => {
    // Bytes were flowing; the model just stopped producing. Retrying the same
    // request on the same route replays the whole generation.
    expect(
      classifyStreamFailure(
        new ProviderError(
          "Modal stream stalled — no model output for 300s after it had already started producing output.",
        ),
      ),
    ).toBe("stall");
    // Survives the router's fallback-chain wrapping.
    expect(
      classifyStreamFailure(
        new Error(
          "No provider could stream the request. — modal: Modal stream stalled — no model output for 300s.",
        ),
      ),
    ).toBe("stall");
    // A route that never answered is still a plain transport failure.
    expect(
      classifyStreamFailure(
        new ProviderError(
          "Modal request timed out before any response (240s) — no data arrived on the connection.",
        ),
      ),
    ).toBe("network");
  });

  it("classifies auth and not-found", () => {
    expect(classifyStreamFailure(new ProviderError("nope", 401))).toBe("auth");
    expect(classifyStreamFailure(new ProviderError("gone", 404))).toBe(
      "not-found",
    );
  });

  it("classifies aborts and unknowns", () => {
    expect(classifyStreamFailure(new Error("The operation was aborted"))).toBe(
      "aborted",
    );
    expect(classifyStreamFailure(new Error("something weird happened"))).toBe(
      "unknown",
    );
  });

  it("prefers the most actionable class in mixed multi-provider failures", () => {
    // Compaction is always safe, so context-overflow wins over an empty tail.
    expect(
      classifyStreamFailure(
        new Error(
          "No provider could stream the request. — a: exceeded the provider input limit (413); b: completed without a visible answer.",
        ),
      ),
    ).toBe("context-overflow");
  });
});

describe("planStreamRecovery — bounded escalation", () => {
  it("aborts are never retried", () => {
    const plan = planStreamRecovery({
      kind: "aborted",
      state: createStreamRecoveryState(),
    });
    expect(plan.action).toBe("give-up");
  });

  it("escalates empty-response recovery: nudge → drop thinking → compact + fallback", () => {
    const state = createStreamRecoveryState();

    const first = planStreamRecovery({ kind: "empty", state });
    expect(first.action).toBe("retry");
    expect(first.nudge).toBeTruthy();
    expect(first.notice).toBeTruthy(); // surfaced once
    expect(first.disableThinking).toBe(false);
    recordRecoveryAttempt(state, "empty");

    const second = planStreamRecovery({ kind: "empty", state });
    expect(second.action).toBe("retry");
    expect(second.disableThinking).toBe(true);
    expect(second.notice).toBeUndefined(); // quiet after the first
    recordRecoveryAttempt(state, "empty");

    const third = planStreamRecovery({ kind: "empty", state });
    expect(third.action).toBe("retry");
    expect(third.forceCompact).toBe(true);
    expect(third.allowModelFallback).toBe(true);
    recordRecoveryAttempt(state, "empty");

    const fourth = planStreamRecovery({ kind: "empty", state });
    expect(fourth.action).toBe("retry");
    recordRecoveryAttempt(state, "empty");

    // Only stops in the worst case: after maxEmpty attempts.
    const fifth = planStreamRecovery({ kind: "empty", state });
    expect(fifth.action).toBe("give-up");
    expect(state.empty).toBe(DEFAULT_STREAM_RECOVERY_LIMITS.maxEmpty);
  });

  it("backs off and tries alternates for rate limits, then gives up", () => {
    const state = createStreamRecoveryState();
    for (let i = 0; i < DEFAULT_STREAM_RECOVERY_LIMITS.maxRateLimit; i += 1) {
      const plan = planStreamRecovery({ kind: "rate-limit", state });
      expect(plan.action).toBe("retry");
      expect(plan.delayMs).toBeGreaterThan(0);
      expect(plan.allowModelFallback).toBe(true);
      recordRecoveryAttempt(state, "rate-limit");
    }
    expect(planStreamRecovery({ kind: "rate-limit", state }).action).toBe(
      "give-up",
    );
  });

  it("follows the exact 10/20/30/40/60 second rate-limit schedule", () => {
    const state = createStreamRecoveryState();
    const schedule = [10_000, 20_000, 30_000, 40_000, 60_000];
    for (const expected of schedule) {
      const plan = planStreamRecovery({ kind: "rate-limit", state });
      expect(plan.action).toBe("retry");
      expect(plan.delayMs).toBe(expected);
      recordRecoveryAttempt(state, "rate-limit");
    }
    expect(planStreamRecovery({ kind: "rate-limit", state }).action).toBe(
      "give-up",
    );
  });

  it("caps provider reset windows at the uniform schedule but honors shorter hints", () => {
    const state = createStreamRecoveryState();
    const long = new ProviderError("rate limited", 429, "", 45);
    expect(
      planStreamRecovery({ kind: "rate-limit", state, error: long }).delayMs,
    ).toBe(10_000);
    recordRecoveryAttempt(state, "rate-limit");
    const short = new ProviderError("rate limited", 429, "", 2);
    expect(
      planStreamRecovery({ kind: "rate-limit", state, error: short }).delayMs,
    ).toBe(2_000);
  });

  it("keeps the uniform schedule when the failure message carries a reset window", () => {
    const state = createStreamRecoveryState();
    const error = new Error(
      "hetzner: Provider request failed with HTTP 429 (retry after 35s)",
    );
    expect(
      planStreamRecovery({ kind: "rate-limit", state, error }).delayMs,
    ).toBe(10_000);
  });

  it("compacts on context overflow before retrying, then gives up", () => {
    const state = createStreamRecoveryState();
    const first = planStreamRecovery({ kind: "context-overflow", state });
    expect(first.action).toBe("retry");
    expect(first.forceCompact).toBe(true);
    recordRecoveryAttempt(state, "context-overflow");
    recordRecoveryAttempt(state, "context-overflow");
    expect(planStreamRecovery({ kind: "context-overflow", state }).action).toBe(
      "give-up",
    );
  });

  it("caps every backoff at maxDelayMs", () => {
    const state = createStreamRecoveryState();
    const plan = planStreamRecovery({
      kind: "rate-limit",
      state,
      limits: { ...DEFAULT_STREAM_RECOVERY_LIMITS, maxDelayMs: 1_000 },
    });
    expect(plan.delayMs).toBeLessThanOrEqual(1_000);
  });

  it("retries a stall on another route straight away and asks for smaller writes", () => {
    const state = createStreamRecoveryState();
    const first = planStreamRecovery({ kind: "stall", state });
    expect(first.action).toBe("retry");
    // The transport is fine, so there is nothing to wait out.
    expect(first.delayMs).toBeLessThanOrEqual(1_000);
    // The same route buffers the same way, so switch immediately.
    expect(first.allowModelFallback).toBe(true);
    expect(first.preferModelFallback).toBe(true);
    expect(first.nudge).toMatch(/small|split|append/i);

    state.stall = DEFAULT_STREAM_RECOVERY_LIMITS.maxStall;
    expect(planStreamRecovery({ kind: "stall", state }).action).toBe("give-up");
  });

  it("gives up once the overall recovery budget is spent, even mid-class", () => {
    const state = createStreamRecoveryState();
    // Spend the whole total budget on cheap network retries.
    state.total = DEFAULT_STREAM_RECOVERY_LIMITS.maxTotal;
    expect(planStreamRecovery({ kind: "empty", state }).action).toBe("give-up");
    expect(planStreamRecovery({ kind: "network", state }).action).toBe(
      "give-up",
    );
  });
});

describe("recordRecoveryAttempt / resetStreamRecoveryState", () => {
  it("increments the right bucket and the total", () => {
    const state = createStreamRecoveryState();
    const kinds: StreamFailureKind[] = [
      "empty",
      "rate-limit",
      "server",
      "network",
      "stall",
      "context-overflow",
      "auth",
      "not-found",
      "unknown",
    ];
    for (const kind of kinds) recordRecoveryAttempt(state, kind);
    expect(state.empty).toBe(1);
    expect(state.rateLimit).toBe(1);
    expect(state.server).toBe(1);
    expect(state.network).toBe(1);
    expect(state.stall).toBe(1);
    expect(state.context).toBe(1);
    // auth + not-found + unknown share the structural bucket.
    expect(state.structural).toBe(3);
    expect(state.total).toBe(kinds.length);

    resetStreamRecoveryState(state);
    expect(state).toEqual(createStreamRecoveryState());
  });
});
