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

/**
 * Conformance contract for provider prefix caching: request N must be a byte
 * prefix of request N+1 except for the appended tail. Injected state blocks
 * follow latest-copy-wins: unchanged blocks stay put, changed blocks are
 * appended, stale copies ride in history until compaction strips them.
 */

const HEAD = "SYSTEM CONSTITUTION\nstable rules";

const requestContext = (turn: number): string =>
  `${REQUEST_CONTEXT_PREFIX}\nOUTCOME CONTRACT\nGoal: goal ${turn}\nTASK STATE\nMode: agent`;
const planBlock = (version: number): string =>
  `${PLAN_CONTEXT_PREFIX} for this session (goal: ship, status: in_progress): rev ${version}`;
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
    history: messages.filter((message) => message.content !== HEAD),
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

function lastCopy(messages: readonly ChatMessage[], prefix: string): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" && message.content.startsWith(prefix)) return message;
  }
  return undefined;
}

describe("cross-turn prompt cache prefix", () => {
  it("keeps every injected block behind the conversation it annotates", () => {
    const { sent } = runTurn([], 1, 3);
    const firstInjected = sent.findIndex(isInjected);
    expect(firstInjected).toBeGreaterThan(0);
    expect(sent.slice(0, firstInjected).some(isInjected)).toBe(false);
  });

  it("keeps the newest revision last so the live copy is unambiguous", () => {
    const { sent } = runTurn([], 1, 5);
    expect(lastCopy(sent, REQUEST_CONTEXT_PREFIX)?.content).toBe(requestContext(1));
    expect(lastCopy(sent, PLAN_CONTEXT_PREFIX)?.content).toContain("rev 1");
    expect(lastCopy(sent, "SESSION STATE / WORKING MEMORY")?.content).toContain("step 5");
    expect(sent.filter((m) => isSessionStateMessage(m.content))).toHaveLength(6);
  });

  it("orders the live blocks deterministically across steps", () => {
    const liveOf = (steps: number): string[] => {
      const sent = runTurn([], 1, steps).sent;
      return [REQUEST_CONTEXT_PREFIX, PLAN_CONTEXT_PREFIX, "SESSION STATE / WORKING MEMORY"].map(
        (prefix) =>
          lastCopy(sent, prefix)!
            .content.split("\n")[0]!
            .replace(/rev \d+/, "rev N")
            .replace(/step \d+/, "step N"),
      );
    };
    expect(liveOf(1)).toEqual(liveOf(4));
  });

  it("preserves the whole previous turn as a shared prefix on the next turn", () => {
    const first = runTurn([], 1, 30);
    const second = runTurn(first.history, 2, 1);
    const shared = sharedPrefixLength(first.sent, second.sent);
    expect(shared).toBe(first.sent.length);
    expect(shared / first.sent.length).toBeGreaterThan(0.95);
  });

  it("still shares the prefix when the previous turn ran a single step", () => {
    const first = runTurn([], 1, 1);
    const second = runTurn(first.history, 2, 1);
    expect(sharedPrefixLength(first.sent, second.sent)).toBe(first.sent.length);
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

  it("keeps single-system dialects working with a user-turn tail", () => {
    const { sent } = runTurn([], 1, 2);
    const normalized = singleLeadingSystemMessages(sent);
    expect(normalized[0]).toMatchObject({ role: "system", content: HEAD });
    expect(normalized.filter((m) => m.role === "system")).toHaveLength(1);
    const last = normalized.at(-1)?.content ?? "";
    expect(last).toContain("SESSION STATE");
    expect(last).toContain("step 2");
  });
});
