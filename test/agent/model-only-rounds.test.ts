import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type { PlanStatus, SessionPlan } from "../../src/store/plan.js";
import { assessCompletion } from "../../src/agent/turn/loop/answer-assessment.js";
import {
  handleModelOnlyRound,
  type ModelOnlyRoundInput,
  type ModelOnlyRoundPorts,
} from "../../src/agent/turn/loop/model-only-rounds.js";

const plan = (status: PlanStatus): SessionPlan => ({
  sessionId: "session-1",
  goal: "assemble the document",
  detail: "",
  kind: "build",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: [
    { id: "t1", title: "Assemble blocks", state: "completed" },
    { id: "t2", title: "Check chrome separation", state: "in_progress" },
    { id: "t3", title: "Cross-pass diff", state: "pending" },
    { id: "t4", title: "Responder audit", state: "pending", responderOwned: true },
  ],
});

const makePorts = (toolsAttached = true) => {
  const messages: ChatMessage[] = [];
  const committed: string[] = [];
  const ports: ModelOnlyRoundPorts = {
    messages,
    provider: "meta",
    model: "muse-spark-1.2",
    toolsAttached,
    notify: () => undefined,
    commitAssistantRetry: (text) => committed.push(text),
    recoveryUserMessage: (content) => ({ role: "user", content, internal: true }),
    writeAssistantMessage: () => undefined,
    unreadResponderIds: () => [],
  };
  return { ports, messages, committed };
};

const input = (
  overrides: Partial<ModelOnlyRoundInput> = {},
): ModelOnlyRoundInput => ({
  assistantVisible: "108 blocks assembled. Moving to the cross-pass diff.",
  wantsAction: true,
  narratedNextStep: false,
  continuationEligible: true,
  continuationChecked: false,
  consecutiveModelOnlyRounds: 1,
  plan: plan("in_progress"),
  ...overrides,
});

describe("model-only continuation check", () => {
  it("asks once when the reply ends while executing plan tasks remain open", () => {
    const { ports, messages, committed } = makePorts();
    const decision = handleModelOnlyRound(ports, input());
    expect(decision.kind).toBe("continuation-check");
    expect(committed).toEqual([input().assistantVisible]);
    const check = messages.at(-1)!;
    expect(check.internal).toBe(true);
    expect(check.content).toContain("[t2] Check chrome separation");
    expect(check.content).toContain("[t3] Cross-pass diff");
    expect(check.content).not.toContain("Responder audit");
    expect(check.content).toMatch(/need the user's input or confirmation/);
  });

  it("accepts the reply that follows a check without escalating", () => {
    const { ports, messages } = makePorts();
    const decision = handleModelOnlyRound(
      ports,
      input({ continuationChecked: true, consecutiveModelOnlyRounds: 2, narratedNextStep: true }),
    );
    expect(decision.kind).toBe("proceed");
    expect(messages).toHaveLength(0);
  });

  it("checks narrated next steps when no plan is active", () => {
    const { ports } = makePorts();
    const decision = handleModelOnlyRound(
      ports,
      input({ plan: undefined, narratedNextStep: true }),
    );
    expect(decision.kind).toBe("continuation-check");
  });

  it.each<PlanStatus>(["draft", "completed", "abandoned"])(
    "does not check a %s plan without narrated next steps",
    (status) => {
      const { ports } = makePorts();
      expect(handleModelOnlyRound(ports, input({ plan: plan(status) })).kind).toBe("proceed");
    },
  );

  it("does not check ineligible replies or turns without tools", () => {
    expect(handleModelOnlyRound(makePorts().ports, input({ continuationEligible: false })).kind).toBe("proceed");
    expect(handleModelOnlyRound(makePorts(false).ports, input()).kind).toBe("proceed");
  });
});

describe("continuation eligibility", () => {
  const assess = (text: string, overrides: { informationalQuery?: boolean; idleOrSocialPrompt?: boolean } = {}) =>
    assessCompletion({
      visible: text,
      canonicalVisible: text,
      livePlan: plan("in_progress"),
      activePlanStatus: "in_progress",
      planApproved: true,
      informationalQuery: overrides.informationalQuery ?? false,
      idleOrSocialPrompt: overrides.idleOrSocialPrompt ?? false,
      buildLikeTurn: true,
      pentestLikeTurn: false,
    });

  it("is eligible for work turns that end on a statement", () => {
    expect(assess("Assembly verified clean. Moving to the cross-pass diff.").continuationEligible).toBe(true);
  });

  it("is not eligible when the reply asks the user something", () => {
    expect(assess("Should I also regenerate the index?").continuationEligible).toBe(false);
    expect(assess("Which layout do you prefer? (`A` or `B`?)").continuationEligible).toBe(false);
  });

  it("is not eligible for informational or social prompts", () => {
    expect(assess("Here is why.", { informationalQuery: true }).continuationEligible).toBe(false);
    expect(assess("Hi!", { idleOrSocialPrompt: true }).continuationEligible).toBe(false);
  });

  it("is not eligible once the plan completes during the turn", () => {
    const assessment = assessCompletion({
      visible: "All done.",
      canonicalVisible: "All done.",
      livePlan: plan("completed"),
      activePlanStatus: "in_progress",
      planApproved: true,
      informationalQuery: false,
      idleOrSocialPrompt: false,
      buildLikeTurn: true,
      pentestLikeTurn: false,
    });
    expect(assessment.continuationEligible).toBe(false);
  });
});
