import { describe, expect, it } from "vitest";

import { createTurnEventEmitter } from "../../src/agent/turn/event-emitter.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { SessionPlan } from "../../src/store/plan.js";
import { buildFileChange } from "../../src/tools/file-diff.js";

describe("createTurnEventEmitter", () => {
  const setup = () => {
    const events: AgentEvent[] = [];
    const state = { visibleCommitted: false };
    const emitter = createTurnEventEmitter(
      { emit: (event) => events.push(event) },
      state,
    );
    return { events, state, emitter };
  };

  it("normalizes, suppresses, and truncates status text exactly", () => {
    const { events, emitter } = setup();
    emitter.writeStatus("  running\n  tests  ");
    emitter.writeStatus("open full output with /output now");
    emitter.writeStatus(`shell.exec ${"x".repeat(100)}`);
    emitter.writeStatus("");
    const keyLine = `switching ${"k".repeat(100)}`;
    emitter.writeStatus(keyLine);
    expect(events).toEqual([
      { type: "status", text: "running tests" },
      { type: "status", text: "shell.exec" },
      { type: "status", text: "working" },
      { type: "status", text: `${keyLine.slice(0, 95)}…` },
    ]);
  });

  it("commits only non-empty sanitized assistant messages", () => {
    const { events, state, emitter } = setup();
    emitter.writeAssistantMessage("   ");
    expect(state.visibleCommitted).toBe(false);
    emitter.writeAssistantMessage("answer");
    expect(state.visibleCommitted).toBe(true);
    expect(events).toEqual([{ type: "assistant-message", text: "answer" }]);
  });

  it("emits the basic event family in call order", () => {
    const { events, emitter } = setup();
    const plan: SessionPlan = {
      sessionId: "session",
      goal: "goal",
      detail: "detail",
      tasks: [],
      status: "active",
      kind: "agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    emitter.writeNotice("warn", "notice");
    emitter.writeThinkingBlock("reasoning");
    emitter.writeToolOutput("tool-1", "first");
    emitter.writeToolOutput("tool-1", "final", { replace: true });
    emitter.writeToolCall("tool-1", { name: "fs.read", args: { path: "a.ts" } });
    emitter.writePlanUpdate(plan);
    emitter.writeToolBlocked("tool-2", "shell.exec", "blocked");
    emitter.writeAbort();
    expect(events).toEqual([
      { type: "notice", level: "warn", text: "notice" },
      { type: "thinking-block", content: "reasoning" },
      { type: "tool-output", id: "tool-1", chunk: "first" },
      { type: "tool-output", id: "tool-1", chunk: "final", replace: true },
      { type: "tool-call", id: "tool-1", name: "fs.read", argsDisplay: "a.ts" },
      { type: "plan-update", plan },
      { type: "tool-blocked", id: "tool-2", name: "shell.exec", reason: "blocked" },
      { type: "turn-aborted" },
    ]);
  });

  it("includes only present tool-result optional fields", () => {
    const { events, emitter } = setup();
    const change = buildFileChange({
      path: "a.ts",
      before: "old\n",
      after: "new\n",
      kind: "update",
    });
    emitter.emitToolResult("tool-1", { ok: true, output: "ok" }, "done");
    emitter.emitToolResult(
      "tool-2",
      { ok: false, output: "failed", exitCode: 0, fileChanges: [change] },
      "failed",
      "/tmp/artifact",
    );
    expect(events).toEqual([
      { type: "tool-result", id: "tool-1", ok: true, summary: "done" },
      {
        type: "tool-result",
        id: "tool-2",
        ok: false,
        summary: "failed",
        exitCode: 0,
        artifactPath: "/tmp/artifact",
        fileChanges: [change],
      },
    ]);
  });

  it("filters empty compaction deltas and preserves compaction payloads", () => {
    const { events, emitter } = setup();
    emitter.writeCompactionStarted("compact-1", 100);
    emitter.writeCompactionDelta("compact-1", "");
    emitter.writeCompactionDelta("compact-1", "", true);
    emitter.writeCompactionDelta("compact-1", "summary");
    emitter.writeCompactionCompleted("compact-1", "summary", 100, 40);
    emitter.writeCompactionFailed("compact-2", "failed", 80);
    expect(events).toEqual([
      { type: "compaction-start", id: "compact-1", beforeTokens: 100 },
      { type: "compaction-delta", id: "compact-1", text: "", replace: true },
      { type: "compaction-delta", id: "compact-1", text: "summary" },
      {
        type: "compaction-completed",
        id: "compact-1",
        summary: "summary",
        beforeTokens: 100,
        afterTokens: 40,
        contextScope: "assembled-request",
      },
      { type: "compaction-failed", id: "compact-2", message: "failed", retainedTokens: 80 },
    ]);
  });
});
