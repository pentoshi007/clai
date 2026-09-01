import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCall, ToolResult } from "../../src/types.js";
import type { OutcomeEnvelope } from "../../src/agent/outcomes.js";
import {
  accountToolOutcome,
  type OutcomeAccountingPorts,
  type OutcomeAccountingState,
} from "../../src/agent/turn/outcome-accounting.js";

interface Wiring {
  deferred: ChatMessage[];
  state: OutcomeAccountingState;
  ports: OutcomeAccountingPorts;
}

function envelope(): OutcomeEnvelope {
  return {
    schemaVersion: 1,
    outcome: {
      schemaVersion: 1,
      id: "outcome-1",
      sessionId: "session-1",
      userIntent: "verify the check",
      kind: "operation",
      criteria: [],
      assumptions: [],
      constraints: [],
      status: "active",
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    evidence: [],
    failedHypotheses: [],
    completedOperations: [],
  };
}

function makeWiring(codingSession: boolean): Wiring {
  const deferred: ChatMessage[] = [];
  const state = {
    retryDependenciesChanged: false,
    retryEnvironmentChanged: false,
    governorState: {
      schemaVersion: 2 as const,
      steps: 0,
      evidenceTotal: 0,
      hypothesisTotal: 0,
      consecutiveNoDelta: 0,
      resourcesUsed: 0,
    },
    governorReflects: 0,
    lastGovernorReason: undefined,
  };
  const ports: OutcomeAccountingPorts = {
    outcomeState: envelope(),
    maxSteps: 40,
    codingSession,
    attemptCount: () => 2,
    moveTurn: () => undefined,
    deferMessage: (message) => deferred.push(message),
  };
  return { deferred, state, ports };
}

function runNoDelta(wiring: Wiring, step: number): void {
  accountToolOutcome(wiring.ports, wiring.state, {
    call: {
      name: "shell.exec",
      args: { command: `run the same verification script ${step}` },
    } as unknown as ToolCall,
    result: { ok: true, output: "all checks OK" },
    toolEventId: `tool-${step}`,
    artifactPath: undefined,
    dispatchedTaskId: undefined,
    probeStateKey: undefined,
  });
}

const governorNotes = (wiring: Wiring): ChatMessage[] =>
  wiring.deferred.filter((message) =>
    message.content.startsWith("PROGRESS GOVERNOR"),
  );

describe("progress governor nudges", () => {
  it("defers at most one message per distinct reflect reason", () => {
    const wiring = makeWiring(false);
    for (let step = 1; step <= 8; step += 1) runNoDelta(wiring, step);
    expect(governorNotes(wiring)).toHaveLength(2);
    expect(
      new Set(governorNotes(wiring).map((message) => message.content)).size,
    ).toBe(2);
  });

  it("escalates the second fire instead of repeating the first note", () => {
    const wiring = makeWiring(false);
    for (let step = 1; step <= 8; step += 1) runNoDelta(wiring, step);
    const notes = governorNotes(wiring);
    expect(notes[0]!.content).not.toContain("Update the plan");
    expect(notes[1]!.content).toContain("Update the plan");
  });

  it("never overrides a user stop or continue prompt", () => {
    for (const codingSession of [false, true]) {
      const wiring = makeWiring(codingSession);
      for (let step = 1; step <= 10; step += 1) runNoDelta(wiring, step);
      for (const message of wiring.deferred) {
        expect(message.content).not.toMatch(/do not stop|keep working/i);
      }
    }
  });
});
