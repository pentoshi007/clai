import { describe, expect, it, vi } from "vitest";
import { finalizeTurn } from "../../src/agent/turn/finalizer.js";
import type { TurnOutcomeStatus } from "../../src/agent/turn-outcome.js";

const run = (status: TurnOutcomeStatus) => {
  const order: string[] = [];
  const ports = {
    settleResponderClaims: vi.fn(() => void order.push("settle")),
    releaseResponderClaims: vi.fn(() => void order.push("release")),
    liveMessages: () => [],
    diagnostics: () => false,
    writeAssistantMessage: () => undefined,
    emitEmptyAssistantMessage: () => undefined,
    emitTurnEnd: () => undefined,
    onMessages: undefined,
    onOutcome: undefined,
  };
  finalizeTurn(ports, {
    answer: "done",
    steps: 1,
    status,
    remainingCriteria: [],
    reason: undefined,
    displayAnswer: undefined,
    loopGuardStop: undefined,
  });
  return { ports, order };
};

describe("turn finalizer responder claims", () => {
  it.each(["succeeded", "partial", "blocked", "failed", "paused_budget"] as const)(
    "settles delivered claims before releasing them when the turn is %s",
    (status) => {
      const { ports, order } = run(status);
      expect(ports.settleResponderClaims).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["settle", "release"]);
    },
  );

  it("leaves delivered claims durable when the turn was aborted", () => {
    const { ports, order } = run("aborted");
    expect(ports.settleResponderClaims).not.toHaveBeenCalled();
    expect(order).toEqual(["release"]);
  });
});
