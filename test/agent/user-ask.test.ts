import { describe, expect, it } from "vitest";
import type { QuestionAnswer, QuestionRequest } from "../../src/app/ports/question-port.js";
import { askUserQuestions, type UserQuestionPorts } from "../../src/agent/turn/tool-execution/user-questions.js";
import { createToolRouting } from "../../src/agent/turn/tool-routing.js";
import {
  formatUserAnswers,
  parseUserQuestions,
  USER_ASK_SKIPPED,
  USER_ASK_TOOL_NAME,
  USER_ASK_UNAVAILABLE,
  userAskCallLimit,
} from "../../src/tools/user-ask.js";
import type { ToolCall } from "../../src/types.js";

const question = {
  question: "Which database should store sessions?",
  header: "Storage backend choice",
  options: [
    { label: "Postgres (Recommended)", description: "Already used for users" },
    { label: "Redis", description: "Faster, needs a new service" },
  ],
};

const call = (args: ToolCall["args"]): ToolCall => ({ name: USER_ASK_TOOL_NAME, args });

const ports = (
  ask: UserQuestionPorts["ask"],
  overrides: Partial<UserQuestionPorts> = {},
): UserQuestionPorts & { readonly calls: () => number; readonly releases: () => number } => {
  let used = 0;
  let releases = 0;
  return {
    ask,
    acquirePrompt: async () => () => {
      releases += 1;
    },
    limit: 2,
    used: () => used,
    setUsed: (count) => {
      used = count;
    },
    calls: () => used,
    releases: () => releases,
    ...overrides,
  };
};

describe("user.ask parsing", () => {
  it("normalizes questions, trims headers, removes control characters, and drops duplicate options", () => {
    const parsed = parseUserQuestions({
      questions: [{ ...question, options: [...question.options, "redis", "Line\u001b[31m\nbreak"], multiSelect: true }],
    }) as QuestionRequest;
    expect(parsed.questions[0]!.header).toBe("Storage backend ");
    expect(parsed.questions[0]!.options.map((option) => option.label)).toEqual([
      "Postgres (Recommended)",
      "Redis",
      "Line [31m break",
    ]);
    expect(parsed.questions[0]!.multiSelect).toBe(true);
  });

  it.each([
    [{}, "provide questions"],
    [{ questions: [question, question, question, question] }, "at most 3 questions"],
    [{ questions: [{ ...question, options: ["Only one"] }] }, "question 1 needs 2 to 4 distinct options"],
    [{ questions: [{ options: question.options }] }, "question 1 needs question text"],
  ])("rejects invalid input %#", (args, message) => {
    expect(parseUserQuestions(args)).toContain(message);
  });

  it("formats selected options and typed answers in question order", () => {
    const request = parseUserQuestions({ questions: [question, { ...question, question: "Anything else?" }] }) as QuestionRequest;
    const answers: QuestionAnswer[] = [{ selected: ["Redis"] }, { selected: [], custom: "Keep a TTL of one day" }];
    expect(formatUserAnswers(request, answers)).toBe([
      "The user answered:",
      "1. Which database should store sessions?",
      "   → Redis",
      "2. Anything else?",
      '   → "Keep a TTL of one day"',
      "Treat these answers as decisions. When planning, record them under USER DECISIONS in the plan detail.",
    ].join("\n"));
  });
});

describe("user.ask execution", () => {
  it("returns the answers and releases the prompt lock", async () => {
    const port = ports(async () => [{ selected: ["Postgres (Recommended)"] }]);
    const result = await askUserQuestions(port, call({ questions: [question] }));
    expect(result.ok).toBe(true);
    expect(result.output).toContain("→ Postgres (Recommended)");
    expect(port.releases()).toBe(1);
  });

  it("reports when no interactive user is available", async () => {
    expect(await askUserQuestions(ports(undefined), call({ questions: [question] }))).toEqual({
      ok: false,
      output: USER_ASK_UNAVAILABLE,
    });
  });

  it("rejects invalid arguments without opening a prompt", async () => {
    let asked = false;
    const result = await askUserQuestions(ports(async () => {
      asked = true;
      return [];
    }), call({ questions: [] }));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^user\.ask failed: /);
    expect(asked).toBe(false);
  });

  it("stops asking once the per-turn limit is used", async () => {
    const port = ports(async () => [{ selected: ["Redis"] }], { limit: 1 });
    expect((await askUserQuestions(port, call({ questions: [question] }))).ok).toBe(true);
    const second = await askUserQuestions(port, call({ questions: [question] }));
    expect(second.ok).toBe(false);
    expect(second.output).toContain("already used its user.ask call");
  });

  it("spends the remaining budget when the user skips", async () => {
    const port = ports(async () => undefined);
    expect(await askUserQuestions(port, call({ questions: [question] }))).toEqual({ ok: true, output: USER_ASK_SKIPPED });
    expect(port.calls()).toBe(2);
  });

  it("allows two calls in plan mode and one otherwise", () => {
    expect(userAskCallLimit(true)).toBe(2);
    expect(userAskCallLimit(false)).toBe(1);
  });

  it("is routed as a stable tool for every mode", () => {
    for (const mode of ["agent", "plan", "ask"] as const) {
      const routing = createToolRouting({
        mode,
        mcpPresent: false,
        subagents: false,
        toolCalling: "native",
        useCompactSystemPrompt: () => false,
      });
      expect(routing.routeToolNames("nvidia", "test-model")).toContain(USER_ASK_TOOL_NAME);
      expect(routing.selectToolDefs(true, false, "nvidia", "test-model")!.map((tool) => tool.name)).toContain(USER_ASK_TOOL_NAME);
    }
  });
});
