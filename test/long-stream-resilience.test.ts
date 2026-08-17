import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_STALL_MARKER,
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  readStreamLines,
  streamIdleBudgets,
} from "../src/llm/http.js";
import {
  INTERRUPTED_REASONING_LIMIT,
  MIN_RESUMPTION_YIELD,
  appendInterruptedReasoning,
  interruptedReasoningBrief,
  isMeaningfulResumptionYield,
} from "../src/agent/interrupted-reasoning.js";
import {
  DEFAULT_STREAM_RECOVERY_LIMITS,
  createStreamRecoveryState,
  planStreamRecovery,
  recordRecoveryAttempt,
} from "../src/agent/stream-recovery.js";

const encoder = new TextEncoder();

function tickingStream(options: {
  chunk: string;
  everyMs: number;
  forMs: number;
}): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(options.chunk));
      }, options.everyMs);
      setTimeout(() => {
        if (timer) clearInterval(timer);
        if (closed) return;
        closed = true;
        controller.close();
      }, options.forMs);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
  return new Response(body);
}

async function drain(
  lines: AsyncGenerator<string, void, void>,
  onLine?: (line: string) => void,
): Promise<number> {
  let count = 0;
  for await (const line of lines) {
    count += 1;
    onLine?.(line);
  }
  return count;
}

describe("long-running provider streams", () => {
  it("gives reasoning-enabled streams a budget that spans minutes of thinking", () => {
    const thinking = streamIdleBudgets(true);
    const plain = streamIdleBudgets(false);
    expect(thinking.idleTimeoutMs).toBe(THINKING_STREAM_IDLE_TIMEOUT_MS);
    expect(plain.idleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    expect(thinking.idleTimeoutMs).toBeGreaterThan(plain.idleTimeoutMs);
    expect(thinking.idleTimeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(thinking.outputIdleTimeoutMs).toBeGreaterThan(thinking.idleTimeoutMs);
  });

  it("keeps reading while the model keeps producing output", async () => {
    let produced = 0;
    const response = tickingStream({
      chunk: "token\n",
      everyMs: 10,
      forMs: 220,
    });
    const lines = readStreamLines(response, {
      idleTimeoutMs: 5_000,
      outputIdleTimeoutMs: 80,
      outputProgress: () => produced,
    });
    const count = await drain(lines, () => {
      produced += 1;
    });
    expect(count).toBeGreaterThan(5);
  });

  it("still fails a stream that keepalives forever without producing output", async () => {
    const response = tickingStream({
      chunk: ": keepalive\n\n",
      everyMs: 5,
      forMs: 2_000,
    });
    await expect(
      drain(
        readStreamLines(response, {
          idleTimeoutMs: 1_500,
          outputIdleTimeoutMs: 60,
          outputProgress: () => 0,
        }),
      ),
    ).rejects.toThrow(new RegExp(STREAM_STALL_MARKER, "i"));
  });

  it("reports a socket that never delivers a byte as a transport failure", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
    );
    await expect(
      drain(
        readStreamLines(response, {
          idleTimeoutMs: 40,
          outputIdleTimeoutMs: 5_000,
          outputProgress: () => 0,
        }),
      ),
    ).rejects.toThrow(/no data/i);
  });

  it("leaves the single-watchdog contract untouched when output is not tracked", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
    );
    await expect(
      drain(readStreamLines(response, { idleTimeoutMs: 40 })),
    ).rejects.toThrow(/stalled/i);
  });
});

describe("interrupted reasoning continuity", () => {
  const long = (marker: string): string =>
    `${marker} ${"reasoned step ".repeat(40)}`;

  it("carries an interrupted think forward as a continuation brief", () => {
    const carried = appendInterruptedReasoning("", long("first"));
    const brief = interruptedReasoningBrief(carried);
    expect(brief).toContain("preserved_reasoning");
    expect(brief).toContain("first");
    expect(brief).toMatch(/instead of re-deriving/i);
  });

  it("ignores reasoning too short to be worth replaying", () => {
    expect(interruptedReasoningBrief("hmm")).toBeUndefined();
    expect(appendInterruptedReasoning("kept", "")).toBe("kept");
  });

  it("does not duplicate reasoning repeated across attempts", () => {
    const once = appendInterruptedReasoning("", long("same"));
    const twice = appendInterruptedReasoning(once, long("same"));
    expect(twice).toBe(once);
  });

  it("keeps the most recent conclusions within a bounded budget", () => {
    let carried = "";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      carried = appendInterruptedReasoning(carried, long(`attempt-${attempt}`));
    }
    expect(carried.length).toBeLessThanOrEqual(INTERRUPTED_REASONING_LIMIT);
    expect(carried).toContain("attempt-11");
    expect(carried).not.toContain("attempt-0 ");
  });
});

describe("resumption yield", () => {
  it("treats a few trickled characters as no progress", () => {
    expect(isMeaningfulResumptionYield(0)).toBe(false);
    expect(isMeaningfulResumptionYield(1)).toBe(false);
    expect(isMeaningfulResumptionYield("colliders".length)).toBe(false);
    expect(isMeaningfulResumptionYield(MIN_RESUMPTION_YIELD - 1)).toBe(false);
  });

  it("treats a substantial chunk as progress", () => {
    expect(isMeaningfulResumptionYield(MIN_RESUMPTION_YIELD)).toBe(true);
    expect(isMeaningfulResumptionYield(8_000)).toBe(true);
  });

  it("abandons a route that only ever trickles, instead of burning the resume budget", () => {
    const state = createStreamRecoveryState();
    let attempts = 0;
    for (let round = 0; round < 20; round += 1) {
      const progressed = isMeaningfulResumptionYield("c".length);
      const plan = planStreamRecovery({ kind: "network", state, progressed });
      if (plan.action === "give-up") break;
      attempts += 1;
      recordRecoveryAttempt(state, "network", progressed);
    }
    expect(attempts).toBe(DEFAULT_STREAM_RECOVERY_LIMITS.maxNetwork);
    expect(state.progressed).toBe(0);
  });

  it("keeps resuming a route that delivers real chunks each time", () => {
    const state = createStreamRecoveryState();
    let attempts = 0;
    for (let round = 0; round < 20; round += 1) {
      const progressed = isMeaningfulResumptionYield(6_000);
      const plan = planStreamRecovery({ kind: "network", state, progressed });
      if (plan.action === "give-up") break;
      attempts += 1;
      recordRecoveryAttempt(state, "network", progressed);
    }
    expect(attempts).toBeGreaterThan(DEFAULT_STREAM_RECOVERY_LIMITS.maxNetwork);
    expect(attempts).toBe(DEFAULT_STREAM_RECOVERY_LIMITS.maxProgressed);
  });
});

describe("recovery budget for attempts that preserved output", () => {
  it("does not spend the blind-retry budget while output keeps landing", () => {
    const state = createStreamRecoveryState();
    for (let attempt = 0; attempt < DEFAULT_STREAM_RECOVERY_LIMITS.maxNetwork + 2; attempt += 1) {
      const plan = planStreamRecovery({
        kind: "network",
        state,
        progressed: true,
      });
      expect(plan.action).toBe("retry");
      recordRecoveryAttempt(state, "network", true);
    }
    expect(state.network).toBe(0);
    expect(state.progressed).toBeGreaterThan(
      DEFAULT_STREAM_RECOVERY_LIMITS.maxNetwork,
    );
  });

  it("still bounds progress-preserving retries", () => {
    const state = createStreamRecoveryState();
    state.progressed = DEFAULT_STREAM_RECOVERY_LIMITS.maxProgressed;
    expect(
      planStreamRecovery({ kind: "network", state, progressed: true }).action,
    ).toBe("give-up");
  });

  it("keeps the blind-retry ladder unchanged when nothing was preserved", () => {
    const state = createStreamRecoveryState();
    for (let attempt = 0; attempt < DEFAULT_STREAM_RECOVERY_LIMITS.maxNetwork; attempt += 1) {
      expect(planStreamRecovery({ kind: "network", state }).action).toBe("retry");
      recordRecoveryAttempt(state, "network");
    }
    expect(planStreamRecovery({ kind: "network", state }).action).toBe("give-up");
    expect(state.progressed).toBe(0);
  });
});
