import { describe, expect, it } from "vitest";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { REQUEST_CONTEXT_PREFIX } from "../src/llm/system-messages.js";
import type { ChatMessage } from "../src/types.js";

const STABLE_BOILERPLATE = "Adaptive professional loop (for work the user wants performed)";

function compose(prompt: string, history?: ChatMessage[]) {
  return composeTurnMessages({
    prompt,
    displayPrompt: prompt,
    images: undefined,
    history,
    mode: "agent",
    systemSections: [
      "AGENT MODE\nAdaptive professional loop (for work the user wants performed): frame, model, cover, decide, act, verify, reconcile.",
      "REQUEST ENVIRONMENT\nOS: test",
    ],
    selectedSkillNames: [],
    nativeToolsActive: true,
    inputTokenBudget: undefined,
    stableSystemContent: () => "SYSTEM CONSTITUTION\nstable rules",
    instructionsBlock: undefined,
    skillsBlock: undefined,
    plan: undefined,
    planApproved: false,
  });
}

function requestContextOf(messages: ChatMessage[]): string {
  const found = [...messages]
    .reverse()
    .find(
      (m) => m.role === "system" && m.content.startsWith(REQUEST_CONTEXT_PREFIX),
    );
  expect(found).toBeDefined();
  return found!.content;
}

describe("per-prompt request context trim", () => {
  it("sends the full context on the first prompt", () => {
    const { messages } = compose("do the first thing");
    const block = requestContextOf(messages);
    expect(block).toContain("OUTCOME CONTRACT");
    expect(block).toContain("do the first thing");
    expect(block).toContain("TASK STATE");
    expect(block).toContain(STABLE_BOILERPLATE);
  });

  it("omits stable boilerplate already in history but keeps the new mandate", () => {
    const first = compose("do the first thing");
    const history = first.messages.filter((m) => m.role !== "system" || m.content.startsWith(REQUEST_CONTEXT_PREFIX));
    const second = compose("do the second thing", history as ChatMessage[]);
    const block = requestContextOf(second.messages);
    expect(block).toContain("OUTCOME CONTRACT");
    expect(block).toContain("do the second thing");
    expect(block).not.toContain("do the first thing");
    expect(block).toContain("TASK STATE");
    expect(block).not.toContain(STABLE_BOILERPLATE);
    expect(block.length).toBeLessThan(requestContextOf(first.messages).length);
  });

  it("re-sends everything after compaction strips the boilerplate", () => {
    const first = compose("do the first thing");
    void first;
    const compacted: ChatMessage[] = [
      { role: "user", content: "do the first thing" },
      { role: "assistant", content: "compacted summary of earlier work" },
    ];
    const second = compose("do the second thing", compacted);
    const block = requestContextOf(second.messages);
    expect(block).toContain(STABLE_BOILERPLATE);
    expect(block).toContain("do the second thing");
  });

  it("keeps the timeline a pure append of the previous request", () => {
    const first = compose("do the first thing");
    const history = first.messages.filter((m) => m.role !== "system" || m.content.startsWith(REQUEST_CONTEXT_PREFIX));
    const second = compose("do the second thing", history as ChatMessage[]);
    const sent1 = first.messages;
    const sent2 = second.messages;
    const shared = sent1.filter((m, i) => JSON.stringify(m) === JSON.stringify(sent2[i]));
    expect(shared.length).toBe(sent1.length);
  });
});
