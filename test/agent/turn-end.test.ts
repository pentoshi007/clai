import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/types.js";
import {
  resolveDeclaredTurnEnd,
  type DeclaredTurnEndInput,
} from "../../src/agent/turn/loop/declared-turn-end.js";
import {
  createTurnCompletionState,
  isTurnEndChecked,
  isTurnEndDeclared,
  recordTurnEndCheck,
} from "../../src/agent/turn/turn-completion.js";
import { createTurnCounters } from "../../src/agent/turn/turn-counters.js";
import { runMetaTool, type MetaToolPorts } from "../../src/agent/turn/tool-execution/meta-tools.js";
import { getToolDefinitions, RUNNER_META_TOOL_NAMES } from "../../src/tools/definitions.js";
import { isQuietMetaTool } from "../../src/app/adapters/quiet-meta-tools.js";
import { TURN_END_REASONS, TURN_END_TOOL_NAME, isTurnEndReason } from "../../src/tools/turn-end.js";
import { renderAgentSystemPrompt, renderCompactAgentSystemPrompt } from "../../src/prompts/index.js";

const turnEnd = (reason: unknown = "completed"): ToolCall => ({
  name: TURN_END_TOOL_NAME,
  args: { reason },
});

const declaration = (
  overrides: Partial<DeclaredTurnEndInput> = {},
): DeclaredTurnEndInput => ({
  declared: true,
  calls: [turnEnd()],
  outcomesNeedReview: false,
  visibleText: "All tests pass and the fix is committed.",
  stepsBeforeRound: 4,
  productiveSteps: 5,
  unreadResponders: false,
  ...overrides,
});

describe("turn.end registration", () => {
  it("is a quiet runner meta tool offered with a closed reason enum", () => {
    expect(RUNNER_META_TOOL_NAMES.has(TURN_END_TOOL_NAME)).toBe(true);
    expect(isQuietMetaTool(TURN_END_TOOL_NAME)).toBe(true);
    const definition = getToolDefinitions().find((entry) => entry.name === TURN_END_TOOL_NAME);
    expect(definition?.parameters).toMatchObject({
      required: ["reason"],
      properties: { reason: { enum: [...TURN_END_REASONS] } },
    });
  });

  it("is documented for text-protocol prompts", () => {
    expect(renderAgentSystemPrompt("fs.read, turn.end", { nativeTools: false })).toContain("turn.end");
    expect(renderCompactAgentSystemPrompt("fs.read, turn.end", { nativeTools: false })).toContain("turn.end");
  });

  it("accepts only the declared reasons", () => {
    for (const reason of TURN_END_REASONS) expect(isTurnEndReason(reason)).toBe(true);
    expect(isTurnEndReason("done")).toBe(false);
    expect(isTurnEndReason(undefined)).toBe(false);
  });
});

describe("turn completion state", () => {
  it("starts undeclared and unchecked for every new turn", () => {
    const counters = createTurnCounters();
    expect(counters.completion).toEqual(createTurnCompletionState());
    expect(isTurnEndDeclared(counters.completion, 0)).toBe(false);
    expect(isTurnEndChecked(counters.completion, 0)).toBe(false);
    expect(createTurnCounters().completion).not.toBe(counters.completion);
  });

  it("scopes a check to the productive step it was issued at", () => {
    const state = createTurnCompletionState();
    recordTurnEndCheck(state, 3, "Done.");
    expect(isTurnEndChecked(state, 3)).toBe(true);
    expect(isTurnEndChecked(state, 4)).toBe(false);
  });
});

describe("resolveDeclaredTurnEnd", () => {
  it("finishes with the visible reply and the declared reason", () => {
    const state = createTurnCompletionState();
    const decision = resolveDeclaredTurnEnd(state, declaration({ calls: [turnEnd("answered")] }));
    expect(decision).toEqual({
      kind: "finish",
      answer: "All tests pass and the fix is committed.",
      reason: "answered",
    });
    expect(isTurnEndDeclared(state, 5)).toBe(true);
  });

  it("finishes alongside successful plan bookkeeping", () => {
    const decision = resolveDeclaredTurnEnd(
      createTurnCompletionState(),
      declaration({ calls: [{ name: "task.update", args: { taskId: "t2", state: "done" } }, turnEnd()] }),
    );
    expect(decision.kind).toBe("finish");
  });

  it("does not count a declaration whose sibling outcomes still need review", () => {
    const state = createTurnCompletionState();
    const decision = resolveDeclaredTurnEnd(
      state,
      declaration({ calls: [{ name: "shell.exec", args: { command: "npm test" } }, turnEnd()], outcomesNeedReview: true }),
    );
    expect(decision).toEqual({ kind: "continue" });
    expect(isTurnEndDeclared(state, 5)).toBe(false);
  });

  it("does not finish while Responder results are unread", () => {
    const state = createTurnCompletionState();
    expect(resolveDeclaredTurnEnd(state, declaration({ unreadResponders: true }))).toEqual({ kind: "continue" });
    expect(isTurnEndDeclared(state, 5)).toBe(false);
  });

  it("ignores rounds without a successful declaration", () => {
    expect(resolveDeclaredTurnEnd(createTurnCompletionState(), declaration({ declared: false }))).toEqual({
      kind: "continue",
    });
  });

  it("reuses the checked reply when the check is answered by turn.end alone", () => {
    const state = createTurnCompletionState();
    recordTurnEndCheck(state, 4, "Should I also regenerate the index?");
    const decision = resolveDeclaredTurnEnd(
      state,
      declaration({ calls: [turnEnd("needs_user_input")], visibleText: "  " }),
    );
    expect(decision).toEqual({
      kind: "finish",
      answer: "Should I also regenerate the index?",
      reason: "needs_user_input",
    });
  });

  it("asks once for a final message when a bare declaration has nothing to show", () => {
    const state = createTurnCompletionState();
    const bare = declaration({ visibleText: "" });
    expect(resolveDeclaredTurnEnd(state, bare)).toEqual({ kind: "request-final-message" });
    expect(resolveDeclaredTurnEnd(state, { ...bare, stepsBeforeRound: 5, productiveSteps: 6 })).toEqual({
      kind: "finish",
      answer: "",
      reason: "completed",
    });
  });

  it("does not reuse a checked reply from an earlier step", () => {
    const state = createTurnCompletionState();
    recordTurnEndCheck(state, 2, "Stale reply.");
    expect(resolveDeclaredTurnEnd(state, declaration({ visibleText: "" }))).toEqual({
      kind: "request-final-message",
    });
  });
});

describe("turn.end meta tool", () => {
  const run = async (call: ToolCall) => {
    const emitted: string[] = [];
    const ports = new Proxy({} as MetaToolPorts, {
      get: (_target, key) =>
        key === "emitToolResult"
          ? (_result: unknown, output: string) => emitted.push(output)
          : () => undefined,
    });
    const outcome = await runMetaTool(ports, call);
    return { outcome, emitted };
  };

  it("records a valid declaration as a successful tool result", async () => {
    const { outcome, emitted } = await run(turnEnd("blocked"));
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.result.ok).toBe(true);
    expect(emitted[0]).toMatch(/^Turn end declared: blocked\./);
  });

  it("rejects an unknown reason without ending the turn", async () => {
    const { outcome } = await run(turnEnd("finished"));
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.contextOutput).toContain(TURN_END_REASONS.join(", "));
  });
});
