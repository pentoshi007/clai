import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type { SessionPlan } from "../../src/store/plan.js";
import {
  handleModelOnlyRound,
  type ModelOnlyRoundInput,
  type ModelOnlyRoundPorts,
} from "../../src/agent/turn/loop/model-only-rounds.js";
import { TURN_END_CHECK_MESSAGE } from "../../src/agent/turn/turn-completion.js";
import { awaitsResponderWake } from "../../src/agent/turn/responder-dependency.js";
import type { BackgroundJob } from "../../src/tools/jobs.js";

const plan: SessionPlan = {
  sessionId: "session-1",
  goal: "assemble the document",
  detail: "",
  kind: "build",
  status: "in_progress",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: [
    { id: "t1", title: "Assemble blocks", state: "completed" },
    { id: "t2", title: "Cross-pass diff", state: "pending" },
  ],
};

const makePorts = (
  overrides: Partial<Pick<ModelOnlyRoundPorts, "toolsAttached" | "canDeclareTurnEnd">> & {
    readonly unread?: readonly string[];
    readonly awaitingResponderWake?: boolean;
  } = {},
) => {
  const messages: ChatMessage[] = [];
  const committed: string[] = [];
  const ports: ModelOnlyRoundPorts = {
    messages,
    provider: "meta",
    model: "muse-spark-1.2",
    toolsAttached: overrides.toolsAttached ?? true,
    canDeclareTurnEnd: overrides.canDeclareTurnEnd ?? true,
    notify: () => undefined,
    commitAssistantRetry: (text) => committed.push(text),
    recoveryUserMessage: (content) => ({ role: "user", content, internal: true }),
    writeAssistantMessage: () => undefined,
    unreadResponderIds: () => overrides.unread ?? [],
    awaitingResponderWake: () => overrides.awaitingResponderWake ?? false,
  };
  return { ports, messages, committed };
};

const input = (
  overrides: Partial<ModelOnlyRoundInput> = {},
): ModelOnlyRoundInput => ({
  assistantVisible: "TCP retransmits unacknowledged segments after a timeout.",
  wantsAction: false,
  turnEndDeclared: false,
  turnEndChecked: false,
  consecutiveModelOnlyRounds: 1,
  plan: undefined,
  ...overrides,
});

describe("model-only turn end check", () => {
  it("asks once, as an internal message, when a reply ends without declaring turn.end", () => {
    const { ports, messages, committed } = makePorts();
    const decision = handleModelOnlyRound(ports, input());
    expect(decision.kind).toBe("turn-end-check");
    expect(committed).toEqual([input().assistantVisible]);
    expect(messages).toEqual([
      { role: "user", content: TURN_END_CHECK_MESSAGE, internal: true },
    ]);
  });

  it("uses one fixed check message regardless of plan or reply content", () => {
    const first = makePorts();
    const second = makePorts();
    handleModelOnlyRound(first.ports, input());
    handleModelOnlyRound(
      second.ports,
      input({ assistantVisible: "Moving to the cross-pass diff.", wantsAction: true, plan }),
    );
    expect(first.messages).toEqual(second.messages);
  });

  it("lets the model decide in the check instead of forcing more work", () => {
    expect(TURN_END_CHECK_MESSAGE).toContain("latest user message");
    expect(TURN_END_CHECK_MESSAGE).toContain("turn.end");
    expect(TURN_END_CHECK_MESSAGE).toMatch(/input or confirmation/);
    expect(TURN_END_CHECK_MESSAGE).toMatch(/told you to stop/);
  });

  it("finishes a declared turn without another request", () => {
    const { ports, messages, committed } = makePorts();
    expect(handleModelOnlyRound(ports, input({ turnEndDeclared: true })).kind).toBe("proceed");
    expect(messages).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });

  it("accepts the reply that follows a check without asking again", () => {
    const { ports, messages } = makePorts();
    const decision = handleModelOnlyRound(
      ports,
      input({ turnEndChecked: true, wantsAction: true, consecutiveModelOnlyRounds: 2, plan }),
    );
    expect(decision.kind).toBe("proceed");
    expect(messages).toHaveLength(0);
  });

  it("does not check when turn.end cannot be offered to the model", () => {
    const { ports, messages } = makePorts({ toolsAttached: false, canDeclareTurnEnd: false });
    expect(handleModelOnlyRound(ports, input()).kind).toBe("proceed");
    expect(messages).toHaveLength(0);
  });

  it("keeps unread Responder results ahead of a declaration", () => {
    const { ports, messages } = makePorts({ unread: ["job-1"] });
    const decision = handleModelOnlyRound(ports, input({ turnEndDeclared: true }));
    expect(decision.kind).toBe("continue-round");
    expect(messages.at(-1)?.content).toContain("job-1");
    expect(messages.at(-1)?.content).not.toContain("TURN END CHECK");
  });

  it("yields without a check while a running Responder job will wake the agent", () => {
    const { ports, messages, committed } = makePorts({ awaitingResponderWake: true });
    const decision = handleModelOnlyRound(
      ports,
      input({ assistantVisible: "Delegated the suite to Responder; I'll analyze it when it lands." }),
    );
    expect(decision.kind).toBe("proceed");
    expect(messages).toHaveLength(0);
    expect(committed).toHaveLength(0);
  });

  it("still asks for unread Responder results while other Responder jobs run", () => {
    const { ports, messages } = makePorts({ unread: ["job-1"], awaitingResponderWake: true });
    expect(handleModelOnlyRound(ports, input()).kind).toBe("continue-round");
    expect(messages.at(-1)?.content).toContain("job-1");
  });

  it("checks again once no Responder job can wake the agent", () => {
    const { ports, messages } = makePorts({ awaitingResponderWake: false });
    expect(handleModelOnlyRound(ports, input()).kind).toBe("turn-end-check");
    expect(messages.at(-1)?.content).toBe(TURN_END_CHECK_MESSAGE);
  });
});

describe("awaitsResponderWake", () => {
  const job = (overrides: Partial<BackgroundJob> = {}): BackgroundJob =>
    ({ id: "job-1", status: "running", responder: true, wakeOnCompletion: true, ...overrides }) as BackgroundJob;

  it("is true only for a running wake-enabled Responder job with an active wake lease", () => {
    expect(awaitsResponderWake([job()], true)).toBe(true);
    expect(awaitsResponderWake([job()], false)).toBe(false);
    expect(awaitsResponderWake([], true)).toBe(false);
  });

  it("ignores ordinary background jobs and Responder jobs whose wake was suppressed", () => {
    expect(awaitsResponderWake([job({ responder: false })], true)).toBe(false);
    expect(awaitsResponderWake([job({ wakeOnCompletion: false })], true)).toBe(false);
    expect(awaitsResponderWake([job({ wakeOnCompletion: undefined })], true)).toBe(true);
  });
});
