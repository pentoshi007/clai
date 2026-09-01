import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type { SessionPlan } from "../../src/store/plan.js";
import {
  ACTIVE_SKILLS_PREFIX,
  AGENT_INSTRUCTIONS_PREFIX,
} from "../../src/agent/injected-blocks.js";
import { PLAN_CONTEXT_PREFIX } from "../../src/agent/plan-tool.js";
import { prepareCompactionCandidateMessages } from "../../src/agent/turn/compaction-candidate.js";

const plan: SessionPlan = {
  sessionId: "session-1",
  goal: "preserve candidate assembly",
  detail: "reinject live state",
  tasks: [],
  status: "active",
  kind: "build",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseMessages = (): ChatMessage[] => [
  { role: "system", content: "stable system prompt" },
  { role: "system", content: `${AGENT_INSTRUCTIONS_PREFIX}\nstale rules` },
  { role: "system", content: `${ACTIVE_SKILLS_PREFIX}\nstale skills` },
  { role: "system", content: `${PLAN_CONTEXT_PREFIX} stale plan` },
  { role: "system", content: "Session memory\n\nsummary" },
];

describe("compaction candidate preparation", () => {
  it("copies the result and replaces live blocks in instructions, skills, plan order", () => {
    const source = baseMessages();
    const candidate = prepareCompactionCandidateMessages({
      messages: source,
      agentInstructionsBlock: `${AGENT_INSTRUCTIONS_PREFIX}\ncurrent rules`,
      activeSkillsBlock: `${ACTIVE_SKILLS_PREFIX}\ncurrent skills`,
      livePlan: plan,
      planApproved: true,
    });

    expect(source).toEqual(baseMessages());
    expect(candidate).not.toBe(source);
    expect(candidate.slice(-3).map((message) => message.content)).toEqual([
      `${AGENT_INSTRUCTIONS_PREFIX}\ncurrent rules`,
      `${ACTIVE_SKILLS_PREFIX}\ncurrent skills`,
      expect.stringMatching(/^ACTIVE PLAN for this session/),
    ]);
    expect(candidate.at(-1)?.content).toContain("user APPROVED this plan");
  });

  it("removes absent injected blocks without changing stale plan context", () => {
    const candidate = prepareCompactionCandidateMessages({
      messages: baseMessages(),
      agentInstructionsBlock: undefined,
      activeSkillsBlock: undefined,
      livePlan: undefined,
      planApproved: false,
    });

    expect(
      candidate.some((message) =>
        message.content.startsWith(AGENT_INSTRUCTIONS_PREFIX),
      ),
    ).toBe(false);
    expect(
      candidate.some((message) => message.content.startsWith(ACTIVE_SKILLS_PREFIX)),
    ).toBe(false);
    expect(
      candidate.some((message) => message.content.startsWith(PLAN_CONTEXT_PREFIX)),
    ).toBe(true);
  });
});
