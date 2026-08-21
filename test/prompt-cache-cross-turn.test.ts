import { describe, expect, it } from "vitest";
import {
  isRequestContextSystemMessage,
  REQUEST_CONTEXT_PREFIX,
  singleLeadingSystemMessages,
  upsertRequestContextMessage,
} from "../src/llm/system-messages.js";
import {
  PLAN_CONTEXT_PREFIX,
  upsertPlanContextMessage,
} from "../src/agent/plan-tool.js";
import {
  isSessionStateMessage,
  upsertSessionStateMessage,
} from "../src/agent/session-state.js";
import type { ChatMessage } from "../src/types.js";

const HEAD = "SYSTEM CONSTITUTION\nstable rules";

const requestContext = (turn: number): string =>
  `${REQUEST_CONTEXT_PREFIX}\nOUTCOME CONTRACT\nGoal: goal ${turn}\nTASK STATE\nMode: agent`;
const planBlock = (version: number): string =>
  `${PLAN_CONTEXT_PREFIX} v${version} for this session (goal: ship, status: in_progress):`;
const stateBlock = (step: number): string =>
  `SESSION STATE / WORKING MEMORY\nstep ${step}`;

function isInjected(message: ChatMessage): boolean {
  return (
    isRequestContextSystemMessage(message) ||
    (message.role === "system" && message.content.startsWith(PLAN_CONTEXT_PREFIX)) ||
    (message.role === "system" && isSessionStateMessage(message.content))
  );
}

function refreshSuffix(messages: ChatMessage[], turn: number, step: number): void {
  upsertRequestContextMessage(messages, requestContext(turn));
  upsertPlanContextMessage(messages, planBlock(turn));
  upsertSessionStateMessage(messages, stateBlock(step));
}

function runTurn(
  history: readonly ChatMessage[],
  turn: number,
  steps: number,
): { sent: ChatMessage[]; history: ChatMessage[] } {
  const messages: ChatMessage[] = [
    { role: "system", content: HEAD },
    ...history.map((message) => ({ ...message })),
    { role: "user", content: `user turn ${turn}` },
  ];
  refreshSuffix(messages, turn, 0);
  for (let step = 1; step <= steps; step += 1) {
    messages.push({ role: "assistant", content: `assistant ${turn}.${step}` });
    messages.push({ role: "tool", content: `tool result ${turn}.${step}` });
    refreshSuffix(messages, turn, step);
  }
  return {
    sent: messages,
    history: messages.filter((message) => !isInjected(message) && message.content !== HEAD),
  };
}

function sharedPrefixLength(a: readonly ChatMessage[], b: readonly ChatMessage[]): number {
  let index = 0;
  while (
    index < a.length &&
    index < b.length &&
    JSON.stringify(a[index]) === JSON.stringify(b[index])
  ) {
    index += 1;
  }
  return index;
}

describe("cross-turn prompt cache prefix", () => {
  it("keeps every injected block behind the conversation it annotates", () => {
    const { sent } = runTurn([], 1, 3);
    const firstInjected = sent.findIndex(isInjected);
    expect(firstInjected).toBeGreaterThan(0);
    expect(sent.slice(firstInjected).every(isInjected)).toBe(true);
  });

  it("keeps exactly one live copy of each injected block", () => {
    const { sent } = runTurn([], 1, 5);
    expect(sent.filter(isRequestContextSystemMessage)).toHaveLength(1);
    expect(
      sent.filter((m) => m.role === "system" && m.content.startsWith(PLAN_CONTEXT_PREFIX)),
    ).toHaveLength(1);
    expect(
      sent.filter((m) => m.role === "system" && isSessionStateMessage(m.content)),
    ).toHaveLength(1);
  });

  it("orders the trailing blocks deterministically across steps", () => {
    const tailOf = (steps: number): string[] =>
      runTurn([], 1, steps)
        .sent.filter(isInjected)
        .map((m) => m.content.split("\n")[0]!.replace(/v\d+/, "vN").replace(/step \d+/, "step N"));
    expect(tailOf(1)).toEqual(tailOf(4));
  });

  it("preserves the whole previous turn as a shared prefix on the next turn", () => {
    const first = runTurn([], 1, 30);
    const second = runTurn(first.history, 2, 1);
    const shared = sharedPrefixLength(first.sent, second.sent);
    expect(shared).toBe(first.sent.length - 3);
    expect(shared / first.sent.length).toBeGreaterThan(0.95);
  });

  it("still shares the prefix when the previous turn ran a single step", () => {
    const first = runTurn([], 1, 1);
    const second = runTurn(first.history, 2, 1);
    expect(sharedPrefixLength(first.sent, second.sent)).toBe(first.sent.length - 3);
  });

  it("grows the shared prefix monotonically over a multi-turn session", () => {
    let history: readonly ChatMessage[] = [];
    let previous: ChatMessage[] | undefined;
    const ratios: number[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      const result = runTurn(history, turn, 5);
      if (previous) {
        ratios.push(sharedPrefixLength(previous, result.sent) / previous.length);
      }
      previous = result.sent;
      history = result.history;
    }
    expect(ratios).toHaveLength(3);
    for (const ratio of ratios) expect(ratio).toBeGreaterThan(0.75);
  });

  it("regresses to a one-message prefix when request context precedes the user turn", () => {
    const legacyTurn = (
      history: readonly ChatMessage[],
      turn: number,
      steps: number,
    ): { sent: ChatMessage[]; history: ChatMessage[] } => {
      const messages: ChatMessage[] = [
        { role: "system", content: HEAD },
        ...history.map((message) => ({ ...message })),
        { role: "system", content: requestContext(turn) },
        { role: "user", content: `user turn ${turn}` },
      ];
      for (let step = 1; step <= steps; step += 1) {
        messages.push({ role: "assistant", content: `assistant ${turn}.${step}` });
        messages.push({ role: "tool", content: `tool result ${turn}.${step}` });
      }
      return {
        sent: messages,
        history: messages.filter(
          (message) => !isInjected(message) && message.content !== HEAD,
        ),
      };
    };
    const first = legacyTurn([], 1, 30);
    const second = legacyTurn(first.history, 2, 1);
    expect(sharedPrefixLength(first.sent, second.sent)).toBe(1);
  });

  it("keeps the trailing blocks in place for single-system dialects", () => {
    const { sent } = runTurn([], 1, 2);
    const normalized = singleLeadingSystemMessages(sent);
    expect(normalized[0]).toMatchObject({ role: "system", content: HEAD });
    expect(normalized.filter((m) => m.role === "system")).toHaveLength(1);
    const tail = normalized.slice(-3).map((m) => m.content);
    expect(tail[0]).toContain(REQUEST_CONTEXT_PREFIX);
    expect(tail[1]).toContain(PLAN_CONTEXT_PREFIX);
    expect(tail[2]).toContain("SESSION STATE");
  });
});
