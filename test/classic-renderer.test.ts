import { describe, expect, it } from "vitest";
import { attachClassicRenderer } from "../src/agent/classic-renderer.js";
import type { AgentEvent } from "../src/agent/events.js";
import type { SessionPlan } from "../src/store/plan.js";

function stripAnsi(text: string): string {
  // biome-ignore lint: ANSI escape sequences are intentional in renderer output.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("classic renderer", () => {
  it("renders a scripted agent event sequence in the classic terminal shape", () => {
    let output = "";
    const renderer = attachClassicRenderer((chunk) => {
      output += chunk;
    });
    const plan: SessionPlan = {
      sessionId: "sess-test",
      goal: "Build the widget",
      detail: "Use the existing structure.",
      status: "draft",
      kind: "coding",
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
      tasks: [
        { id: "t1", title: "Inspect files", state: "done" },
        { id: "t2", title: "Wire events", state: "pending" },
      ],
    };
    const events: AgentEvent[] = [
      { type: "turn-start", prompt: "do it" },
      { type: "notice", level: "info", text: "current-info question detected" },
      { type: "tool-call", id: "tool-1", name: "shell.exec", argsDisplay: '{"command":"echo hi"}' },
      { type: "tool-output", id: "tool-1", chunk: "ok\n" },
      { type: "tool-output", id: "tool-1", chunk: "hello\nworld" },
      { type: "tool-result", id: "tool-1", ok: true, summary: "ignored by classic result path" },
      { type: "thinking-block", content: "reasoned privately" },
      { type: "assistant-message", text: "**Done:** completed." },
      { type: "plan-update", plan },
      { type: "turn-end", finalAnswer: "Done: completed.", steps: 1 },
    ];

    events.forEach(renderer.onEvent);

    expect(stripAnsi(output)).toMatchInlineSnapshot(`
      "  ℹ current-info question detected
        ▶ shell.exec {"command":"echo hi"}
        ✓
        hello
        world
        ▸ thinking collapsed — Ctrl+T to expand
        Done: completed.
        ● planning
        📋 Build the widget  [1/2]
        [x] 1. Inspect files
        [ ] 2. Wire events
        ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,
          or /discard to cancel it. Any other message refines this plan.
      "
    `);
  });
});
