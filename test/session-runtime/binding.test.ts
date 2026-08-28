import { describe, expect, it } from "vitest";
import type { SessionState } from "../../src/app/controllers/session-controller.js";
import { asSessionId } from "../../src/app/events/app-event.js";
import { runtimeSessionBusy } from "../../src/session-runtime/binding.js";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: asSessionId("session"),
    mode: "agent",
    provider: undefined,
    model: undefined,
    running: false,
    compacting: false,
    historyLength: 0,
    queued: [],
    responder: {
      mode: "off",
      running: 0,
      ready: 0,
      delivered: 0,
      archived: 0,
      failed: 0,
    },
    title: undefined,
    contextSnapshot: undefined,
    contextUsage: undefined,
    contextChip: undefined,
    ...overrides,
  };
}

describe("runtimeSessionBusy", () => {
  it("is false only for a truly idle session", () => {
    expect(runtimeSessionBusy(state())).toBe(false);
  });

  it.each([
    { running: true },
    { compacting: true },
    { queued: ["next"] },
    { responder: { ...state().responder, running: 1, mode: "listening" as const } },
    { responder: { ...state().responder, ready: 1, mode: "listening" as const } },
    { responder: { ...state().responder, delivered: 1, mode: "listening" as const } },
  ])("keeps active work alive for $running$compacting", (overrides) => {
    expect(runtimeSessionBusy(state(overrides as Partial<SessionState>))).toBe(true);
  });
});
