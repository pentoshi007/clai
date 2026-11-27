import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../../src/types.js";
import { compactMessagesWithSummary } from "../../src/agent/context-manager.js";
import { planContextMessage } from "../../src/agent/plan/context-message.js";
import { createPlan, deletePlan, savePlan, type SessionPlan } from "../../src/store/plan.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { runAgentTurn } from "../../src/agent/runner.js";

const streamMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (request: CompletionRequest, onToken: (text: string) => void) =>
      streamMock(request, onToken),
    completeWithProvider: (request: CompletionRequest) => streamMock(request, () => undefined),
  };
});

const TASKS = [
  "Scaffold the Vite React app",
  "Build the timeline feed with optimistic posting",
  "Run the build and probe the dev server",
];

function draftPlan(sessionId: string): SessionPlan {
  const plan = createPlan({
    sessionId,
    goal: "Twitter-style app in ~/Desktop/titter",
    detail: "Use Vite, React and Tailwind. Keep state in a local store.",
    kind: "coding",
    taskTitles: TASKS,
  });
  plan.tasks[1]!.acceptanceCriteria = "posting shows instantly and survives reload";
  plan.tasks[1]!.steps = ["add the post composer", "persist posts to localStorage"];
  return plan;
}

async function compactedHistory(plan: SessionPlan, approved: boolean): Promise<ChatMessage[]> {
  const research: ChatMessage[] = [
    { role: "user", content: "build a twitter clone in ~/Desktop/titter" },
    { role: "assistant", content: "Checked the folder and toolchain. ".repeat(80) },
    { role: "system", content: planContextMessage(plan, approved) },
    { role: "user", content: "use a dark theme" },
    { role: "assistant", content: "Revised the plan for a dark theme." },
  ];
  const result = await compactMessagesWithSummary(
    research,
    async () => "## Research evidence\nNode 22 and npm 10 are installed; the folder is empty.",
    { budgetTokens: 0, keepRecent: 2, purpose: approved ? "plan-implement" : "default" },
  );
  expect(result.summarized).toBe(true);
  expect(result.messages.some((m) => m.content.startsWith("ACTIVE PLAN"))).toBe(false);
  return result.messages;
}

async function firstRequestAfterCompaction(
  sessionId: string,
  approved: boolean,
): Promise<CompletionRequest> {
  const plan = draftPlan(sessionId);
  if (approved) plan.status = "approved";
  await savePlan(plan);
  const history = await compactedHistory(plan, approved);
  const requests: CompletionRequest[] = [];
  const abort = new AbortController();
  streamMock.mockImplementation(async (request: CompletionRequest): Promise<CompletionResult> => {
    requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    abort.abort();
    throw abort.signal.reason;
  });
  const policy = createSessionPolicy(sessionId);
  policy.planApproved.value = approved;
  try {
    await runAgentTurn(approved ? "Plan approved. Execute it." : "add a search bar to the plan", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 2,
      history,
      signal: abort.signal,
      displayPrompt: null,
      session: policy,
      mode: approved ? "agent" : "plan",
      onEvent: () => undefined,
    });
  } finally {
    await deletePlan(sessionId);
  }
  expect(requests.length).toBeGreaterThan(0);
  return requests[0]!;
}

function activePlanBlock(request: CompletionRequest): string {
  const blocks = request.messages.filter(
    (m) => m.role === "system" && m.content.startsWith("ACTIVE PLAN for this session"),
  );
  expect(blocks).toHaveLength(1);
  return blocks[0]!.content;
}

function expectFullPlan(block: string): void {
  expect(block).toContain("Twitter-style app in ~/Desktop/titter");
  expect(block).toContain("Use Vite, React and Tailwind.");
  for (const [index, title] of TASKS.entries()) expect(block).toContain(`[t${index + 1}] (pending) ${title}`);
  expect(block).toContain("[acceptance: posting shows instantly and survives reload]");
  expect(block).toContain("- persist posts to localStorage");
}

describe("plan context after compaction", () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it("re-sends the full approved plan and task list on the implement turn", async () => {
    const block = activePlanBlock(await firstRequestAfterCompaction("plan-compact-agent", true));
    expectFullPlan(block);
    expect(block).toContain("The user APPROVED this plan.");
    expect(block).toContain("START WITH TASK t1");
  });

  it("re-sends the full draft plan and task list in plan mode", async () => {
    const block = activePlanBlock(await firstRequestAfterCompaction("plan-compact-plan", false));
    expectFullPlan(block);
    expect(block).toContain("This plan is NOT yet approved");
  });
});
