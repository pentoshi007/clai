import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  fromWireName,
  sanitizeToolName,
} from "../src/llm/tool-protocol.js";
import "../src/tools/definitions.js";
import { normalizeToolCall } from "../src/tools/registry.js";
import { fsReplaceLines } from "../src/tools/fs.js";
import {
  looksLongRunning,
  looksLikeOneShotScaffolder,
} from "../src/tools/command-intent.js";
import {
  handlePlanTool,
  resolvePlanTaskId,
  slugifyTaskId,
} from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import {
  clearAllPlans,
  createPlan,
  savePlan,
} from "../src/store/plan.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../src/ui-core/rendering/sanitize-display.js";

describe("X1 sanitize tool names", () => {
  it("strips channel/commentary pollution", () => {
    expect(sanitizeToolName("fs.write<|channel|>commentary")).toBe("fs.write");
    expect(fromWireName("fs_write<|channel|>commentary")).toBe("fs.write");
    expect(
      normalizeToolCall({
        name: "fs.write<|channel|>commentary",
        args: { path: "a.ts", content: "x" },
      }).name,
    ).toBe("fs.write");
  });
});

describe("X2 multi-tool stream isolation", () => {
  it("keeps parallel indices isolated (tool_check vs fs_write)", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "a",
      function: {
        name: "tool_check",
        arguments: '{"tools":["npm","node"]}',
      },
    });
    accumulateOpenAiToolCallDelta(state, {
      index: 1,
      id: "b",
      function: {
        name: "fs_write",
        arguments: '{"path":"App.jsx","content":"export default App"}',
      },
    });
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("tool.check");
    expect(calls[0]!.args).toEqual({ tools: ["npm", "node"] });
    expect(calls[1]!.name).toBe("fs.write");
    expect(calls[1]!.args).toEqual({
      path: "App.jsx",
      content: "export default App",
    });
  });

  it("ignores mid-index name flip to a different tool", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { name: "tool_check", arguments: '{"tools":[' },
    });
    // Corrupt stream tries to rename same index
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { name: "fs_write", arguments: '"npm"]}' },
    });
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls[0]!.name).toBe("tool.check");
  });
});

describe("X3 plan taskId aliases", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("resolves slug aliases from plan.create task objects", async () => {
    const session = createSessionPolicy("x3-slug");
    const created = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Library CLI pack",
          detail: "no web server",
          kind: "coding",
          tasks: [
            { id: "scaffold_project", title: "Scaffold package.json" },
            { id: "implement_cli", title: "Implement CLI" },
            { title: "Run unit tests" },
          ],
        },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(created.ok).toBe(true);
    expect(created.plan?.tasks[0]!.id).toBe("t1");
    expect(resolvePlanTaskId(created.plan!, "scaffold_project")).toBe("t1");
    expect(resolvePlanTaskId(created.plan!, "t1")).toBe("t1");

    const upd = await handlePlanTool(
      {
        name: "task.update",
        args: { taskId: "scaffold_project", state: "in_progress" },
      },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );
    // Plan not approved — task.update still works on the plan store
    expect(upd.ok).toBe(true);
    expect(upd.plan?.tasks[0]!.state).toBe("in_progress");
  });

  it("slugifyTaskId normalizes titles", () => {
    expect(slugifyTaskId("Scaffold the project!")).toBe("scaffold_the_project");
  });
});

describe("X5 scaffold not long-running", () => {
  it("keeps npm create vite / create-next in foreground", () => {
    expect(
      looksLikeOneShotScaffolder(
        "npm create vite@latest myapp -- --template react",
      ),
    ).toBe(true);
    expect(
      looksLongRunning("npm create vite@latest myapp -- --template react"),
    ).toBe(false);
    expect(
      looksLongRunning(
        'npx --yes create-next-app@latest myapp --yes --eslint',
      ),
    ).toBe(false);
    expect(looksLongRunning("npm run dev")).toBe(true);
  });
});

describe("X6 replaceLines empty content deletes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("deletes a line range with empty content", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".test-tmp-x6-"));
    dirs.push(dir);
    const file = join(dir, "App.jsx");
    writeFileSync(file, "line1\nexport default App\ndupe\nline4\n");
    const result = await fsReplaceLines(file, 2, 3, "");
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/sha256_12=/);
    expect(readFileSync(file, "utf8")).toBe("line1\nline4\n");
  });
});

describe("X8 ordered done", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("rejects done on t3 while t2 still pending", async () => {
    const session = createSessionPolicy("x8-order");
    session.planApproved.value = true;
    const plan = createPlan({
      sessionId: "x8-order",
      goal: "g",
      detail: "",
      taskTitles: ["one", "two", "three"],
    });
    plan.tasks[0]!.state = "done";
    await savePlan(plan);

    const result = await handlePlanTool(
      {
        name: "task.update",
        args: { taskId: "t3", state: "done" },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/earlier task|\[t2\]/i);
  });
});

describe("X9 CSI strip", () => {
  it("removes CSI sequences from assistant text", () => {
    // ESC [ … u is a full CSI sequence; final letter is the terminator.
    const dirty = "approved p\x1b[118;1:3ulan done";
    expect(sanitizeAssistantText(dirty)).toBe("approved plan done");
    expect(sanitizeAssistantText("ok\x1b[31mred\x1b[0m")).toBe("okred");
  });
});

describe("X11 loop-guard re-read after mutate", () => {
  it("allows fs.read freely after successful reads and after write", () => {
    const guard = new LoopGuard();
    const path = "src/App.jsx";
    const readArgs = { path };
    guard.recordAttempt(1, "fs.read", readArgs, true);
    guard.recordAttempt(2, "fs.read", readArgs, true);
    guard.recordAttempt(3, "fs.read", readArgs, true);
    // Successful re-reads are never blocked.
    expect(guard.shouldBlock("fs.read", readArgs).block).toBe(false);
    guard.recordAttempt(4, "fs.write", { path, content: "x" }, true);
    expect(guard.shouldBlock("fs.read", readArgs).block).toBe(false);
  });
});

describe("task handoff after done", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("modelNote after done tells exact next in_progress call", async () => {
    const session = createSessionPolicy("handoff-done");
    session.planApproved.value = true;
    const plan = createPlan({
      sessionId: "handoff-done",
      goal: "g",
      detail: "",
      taskTitles: ["scaffold", "implement", "install"],
    });
    plan.tasks[0]!.state = "in_progress";
    await savePlan(plan);

    const result = await handlePlanTool(
      {
        name: "task.update",
        args: { taskId: "t1", state: "done" },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.modelNote).toMatch(
      /NEXT:.*taskId:"t2".*in_progress|open only the next task/i,
    );
  });
});
