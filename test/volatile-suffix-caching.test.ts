import { describe, expect, it } from "vitest";
import {
  SESSION_STATE_PREFIX,
  upsertSessionStateMessage,
} from "../src/agent/session-state.js";
import {
  PLAN_CONTEXT_PREFIX,
  upsertPlanContextMessage,
} from "../src/agent/plan-tool.js";
import {
  RESPONDER_CONTEXT_PREFIX,
  upsertResponderContextMessage,
} from "../src/agent/responder-context.js";

/**
 * Provider prompt caching pays off only while the request PREFIX is
 * byte-stable. Plan / session-state / responder blocks are mutable and are
 * refreshed several times per turn, so a refresh must never rewrite, move, or
 * delete bytes that were already sent: an unchanged block stays exactly where
 * it is and a changed block is appended as a new copy (latest copy wins).
 */

type Message = { role: string; content: string };

const VOLATILE_PREFIXES = [
  SESSION_STATE_PREFIX,
  PLAN_CONTEXT_PREFIX,
  RESPONDER_CONTEXT_PREFIX,
];

function isVolatile(message: Message): boolean {
  return (
    message.role === "system" &&
    VOLATILE_PREFIXES.some((prefix) => message.content.startsWith(prefix))
  );
}

function stablePrefix(messages: Message[]): Message[] {
  const firstVolatile = messages.findIndex(isVolatile);
  return firstVolatile < 0 ? messages : messages.slice(0, firstVolatile);
}

function countStartingWith(messages: Message[], prefix: string): number {
  return messages.filter(
    (message) => message.role === "system" && message.content.startsWith(prefix),
  ).length;
}

function baseConversation(): Message[] {
  return [
    { role: "system", content: "CONSTITUTION: stable agent prefix" },
    { role: "user", content: "build the thing" },
    { role: "assistant", content: "working on it" },
    { role: "tool", content: "Tool fs.write result (exit=0, ok=true):\nwrote" },
  ];
}

describe("volatile blocks stay a cacheable request suffix", () => {
  it("leaves the request byte-identical when a refresh renders the same block", () => {
    const messages = baseConversation();
    upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v1`);
    upsertSessionStateMessage(messages, "step 1");
    const sent = JSON.stringify(messages);
    for (let step = 0; step < 7; step += 1) {
      upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v1`);
      upsertSessionStateMessage(messages, "step 1");
    }
    expect(JSON.stringify(messages)).toBe(sent);
    expect(messages).toHaveLength(baseConversation().length + 2);
  });

  it("appends the new copy and keeps the old bytes in place when a block changes", () => {
    const messages = baseConversation();
    upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v1`);
    upsertSessionStateMessage(messages, "step 1");
    const sent = [...messages];
    messages.push({ role: "assistant", content: "next step" });
    messages.push({ role: "tool", content: "result" });
    upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v2`);
    upsertSessionStateMessage(messages, "step 2");
    expect(messages.slice(0, sent.length)).toEqual(sent);
    expect(messages).toHaveLength(sent.length + 4);
    expect(messages[sent.length - 2]!.content).toContain("v1");
    expect(messages.at(-2)!.content).toContain("v2");
    expect(messages.at(-1)!.content).toContain("step 2");
  });

  it("keeps the live blocks in deterministic order across many refreshes", () => {
    const tailOf = (): string[] => {
      const messages = baseConversation();
      for (let step = 1; step <= 7; step += 1) {
        upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v${step}`);
        upsertSessionStateMessage(messages, `step ${step}`);
        upsertResponderContextMessage(
          messages,
          `${RESPONDER_CONTEXT_PREFIX}\njobs: ${step}`,
        );
      }
      return messages
        .filter(isVolatile)
        .map((m) => m.content.split("\n")[0]!);
    };
    expect(tailOf()).toEqual(tailOf());
  });

  it("never inserts a volatile block ahead of the conversation", () => {
    const messages = baseConversation();
    const before = stablePrefix(messages).map((m) => `${m.role}:${m.content}`);
    upsertPlanContextMessage(messages, `${PLAN_CONTEXT_PREFIX} v1`);
    upsertSessionStateMessage(messages, "open task t1");
    const after = stablePrefix(messages).map((m) => `${m.role}:${m.content}`);
    expect(after).toEqual(before);
    const firstVolatile = messages.findIndex(isVolatile);
    expect(messages.slice(firstVolatile).every(isVolatile)).toBe(true);
  });

  it("marks the responder block cleared without rewriting sent bytes when there is nothing to report", () => {
    const messages = baseConversation();
    upsertResponderContextMessage(
      messages,
      `${RESPONDER_CONTEXT_PREFIX}\njobs: 1`,
    );
    expect(countStartingWith(messages, RESPONDER_CONTEXT_PREFIX)).toBe(1);
    const sent = [...messages];
    upsertResponderContextMessage(messages, undefined);
    expect(messages.slice(0, sent.length)).toEqual(sent);
    expect(messages.at(-1)!.content).toBe(`${RESPONDER_CONTEXT_PREFIX}\n(cleared)`);
    expect(countStartingWith(messages, RESPONDER_CONTEXT_PREFIX)).toBe(2);
    upsertResponderContextMessage(messages, undefined);
    expect(messages).toHaveLength(sent.length + 1);
  });
});
