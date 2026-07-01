import { describe, it, expect } from "vitest";
import {
  initialState,
  reducer,
  serializeTranscriptForCompaction,
  type TuiState,
  type ToolItem,
  type AssistantItem,
} from "../src/tui/state.js";
import type { AgentEvent } from "../src/agent/events.js";
import { evaluateTui, MIN_COLS, MIN_ROWS } from "../src/tui/can-use-tui.js";
import type { SessionPlan } from "../src/store/plan.js";
import { renderItemLines } from "../src/tui/render-lines.js";

function apply(state: TuiState, events: AgentEvent[]): TuiState {
  return events.reduce((s, event) => reducer(s, { type: "event", event }), state);
}

// Rendered lines carry ANSI styling (e.g. the `ctrl+o` hint is bolded), so
// assertions on hint text strip the escape codes first.
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("tui reducer — submit & turn lifecycle", () => {
  it("adds a user item and marks the turn running on submit", () => {
    const s = reducer(initialState(), { type: "submit", text: "hello" });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "user", text: "hello", done: true });
    expect(s.status.running).toBe(true);
    expect(s.status.startedAt).toBeTypeOf("number");
  });

  it("turn-end finalizes items and returns to idle", () => {
    let s = reducer(initialState(), { type: "submit", text: "hi" });
    s = apply(s, [
      { type: "assistant-delta", text: "par" },
      { type: "assistant-delta", text: "tial" },
    ]);
    // streamed text is buffered, not committed as an item yet
    expect(s.streaming).toBe("partial");
    s = apply(s, [
      { type: "assistant-message", text: "partial" },
      { type: "turn-end", finalAnswer: "partial", steps: 1 },
    ]);
    expect(s.streaming).toBe("");
    expect(s.status.running).toBe(false);
    expect(s.items.every((i) => i.done)).toBe(true);
    expect(s.items.some((i) => i.kind === "assistant")).toBe(true);
  });

  it("turn-aborted appends a warning notice and stops", () => {
    let s = reducer(initialState(), { type: "submit", text: "go" });
    s = apply(s, [{ type: "turn-aborted" }]);
    expect(s.status.running).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });
});

describe("tui reducer — event → item mapping", () => {
  it("builds a tool card across call/output/result and correlates by id", () => {
    let s = initialState();
    s = apply(s, [
      { type: "tool-call", id: "t1", name: "shell.exec", argsDisplay: "ls" },
      { type: "tool-output", id: "t1", chunk: "a\n" },
      { type: "tool-output", id: "t1", chunk: "b\n" },
    ]);
    let tool = s.items.find((i): i is ToolItem => i.kind === "tool")!;
    expect(tool.status).toBe("running");
    expect(tool.output).toBe("a\nb\n");
    expect(tool.done).toBe(false);

    s = apply(s, [
      { type: "tool-result", id: "t1", ok: false, exitCode: 2, summary: "boom" },
    ]);
    tool = s.items.find((i): i is ToolItem => i.kind === "tool")!;
    expect(tool.status).toBe("fail");
    expect(tool.exitCode).toBe(2);
    expect(tool.done).toBe(true);
  });

  it("tool-blocked creates a blocked card when no prior call exists", () => {
    const s = apply(initialState(), [
      { type: "tool-blocked", id: "b1", name: "net.scan", reason: "out of scope" },
    ]);
    const tool = s.items.find((i): i is ToolItem => i.kind === "tool")!;
    expect(tool.status).toBe("blocked");
    expect(tool.summary).toBe("out of scope");
    expect(tool.done).toBe(true);
  });

  it("buffers assistant deltas in `streaming` and commits on assistant-message", () => {
    let s = apply(initialState(), [
      { type: "assistant-delta", text: "Hel" },
      { type: "assistant-delta", text: "lo" },
    ]);
    expect(s.streaming).toBe("Hello");
    expect(s.items.filter((i): i is AssistantItem => i.kind === "assistant")).toHaveLength(0);

    s = apply(s, [{ type: "assistant-message", text: "Hello world" }]);
    expect(s.streaming).toBe("");
    const asst = s.items.filter((i): i is AssistantItem => i.kind === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0]!).toMatchObject({ text: "Hello world", streaming: false, done: true });
  });

  it("discards streamed tool-call text when a real tool-call arrives", () => {
    let s = apply(initialState(), [
      { type: "assistant-delta", text: '```tool\n{"name":"shell.exec"}' },
    ]);
    expect(s.streaming).not.toBe("");
    s = apply(s, [{ type: "tool-call", id: "t1", name: "shell.exec", argsDisplay: "ls" }]);
    expect(s.streaming).toBe("");
    expect(s.items.some((i) => i.kind === "tool")).toBe(true);
    expect(s.items.some((i) => i.kind === "assistant")).toBe(false);
  });

  it("ignores empty assistant-message (no blank bubble)", () => {
    const s = apply(initialState(), [{ type: "assistant-message", text: "   " }]);
    expect(s.items.filter((i) => i.kind === "assistant")).toHaveLength(0);
  });

  it("updates the plan card in place rather than appending", () => {
    const plan = (n: number): SessionPlan => ({
      sessionId: "s",
      goal: "build",
      detail: "",
      tasks: Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        title: `task ${i}`,
        state: "pending" as const,
      })),
      status: "draft",
      kind: "general",
      createdAt: "",
      updatedAt: "",
    });
    let s = apply(initialState(), [{ type: "plan-update", plan: plan(1) }]);
    s = apply(s, [{ type: "plan-update", plan: plan(3) }]);
    const plans = s.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
  });

  it("parses the step number from status events", () => {
    const s = apply(initialState(), [{ type: "status", text: "step 4" }]);
    expect(s.status.step).toBe(4);
  });
});

describe("tui reducer — thinking & notices", () => {
  it("collects thinking-delta into a preview and commits a thinking block", () => {
    let s = apply(initialState(), [{ type: "thinking-delta", text: "mulling " }]);
    expect(s.thinkingPreview).toContain("mulling");
    s = apply(s, [{ type: "thinking-block", content: "done thinking" }]);
    expect(s.thinkingPreview).toBe("");
    expect(s.items.at(-1)).toMatchObject({ kind: "thinking", content: "done thinking" });
  });

  it("toggle-thinking flips the expanded flag", () => {
    const s = reducer(initialState(), { type: "toggle-thinking" });
    expect(s.thinkingExpanded).toBe(true);
  });

  it("queues and dequeues composer messages", () => {
    let s = reducer(initialState(), { type: "queue", text: "next" });
    expect(s.queued).toEqual(["next"]);
    s = reducer(s, { type: "dequeue" });
    expect(s.queued).toEqual([]);
  });
});

describe("tui reducer — history restore", () => {
  it("restores saved transcript items before falling back to chat messages", () => {
    const s = reducer(initialState(), {
      type: "load-history",
      messages: [
        { role: "user", content: "summarized prompt" },
        { role: "assistant", content: "summarized answer" },
      ],
      transcript: [
        { kind: "user", id: "u1", text: "full prompt", done: true },
        { kind: "thinking", id: "th1", content: "internal plan preview", done: true },
        {
          kind: "tool",
          id: "t1",
          name: "shell.exec",
          argsDisplay: "whoami",
          output: "aniketpandey\n",
          status: "ok",
          done: true,
        },
        { kind: "assistant", id: "a1", text: "final answer", streaming: false, done: true },
      ],
    });

    expect(s.items.map((item) => item.kind)).toEqual(["user", "thinking", "tool", "assistant"]);
    expect(s.items.find((item): item is ToolItem => item.kind === "tool")?.output).toContain("aniketpandey");
  });

  it("keeps old message-only sessions readable", () => {
    const s = reducer(initialState(), {
      type: "load-history",
      messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old answer" },
      ],
    });

    expect(s.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });
});

describe("toggle actions", () => {
  it("toggle-output flips the outputExpanded flag", () => {
    const s = reducer(initialState(), { type: "toggle-output" });
    expect(s.outputExpanded).toBe(true);
  });

  it("collapsed and expanded tool outputs render in place with clear hints", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-expand",
      name: "shell.exec",
      argsDisplay: "printf lines",
      output: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
      status: "ok",
      done: true,
    };
    const collapsed = stripAnsi(
      renderItemLines(item, {
        width: 100,
        thinkingExpanded: false,
        outputExpanded: false,
        running: false,
      }).join("\n"),
    );
    expect(collapsed).toContain("+2 more line(s) · ctrl+o to expand in place");
    expect(collapsed).not.toContain("five");

    const expanded = stripAnsi(
      renderItemLines(item, {
        width: 100,
        thinkingExpanded: false,
        outputExpanded: true,
        running: false,
      }).join("\n"),
    );
    expect(expanded).toContain("five");
    expect(expanded).toContain("expanded · ctrl+o/esc to collapse");
  });
});

describe("tui transcript formatting", () => {
  it("wraps long assistant text into multiple transcript lines", () => {
    const item: AssistantItem = {
      kind: "assistant",
      id: "a-wrap",
      text: "This is a very long assistant sentence that should continue onto more than one visible terminal line instead of being ellipsized.",
      streaming: false,
      done: true,
    };
    const lines = renderItemLines(item, {
      width: 48,
      thinkingExpanded: false,
      outputExpanded: false,
      running: false,
    });
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join("\n")).not.toContain("…");
  });

  it("renders the user badge label distinctly from the prompt body", () => {
    const rendered = renderItemLines(
      { kind: "user", id: "u-theme", text: "hello", done: true },
      {
        width: 80,
        thinkingExpanded: false,
        outputExpanded: false,
        running: false,
      },
    ).join("\n");
    expect(rendered.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")).toMatch(/^ you\s+hello/);
  });

  it("labels shell commands and their output instead of showing ambiguous bare text", () => {
    const item: ToolItem = {
      kind: "tool",
      id: "tool-1",
      name: "shell.exec",
      argsDisplay: "whoami",
      output: "aniketpandey\n",
      status: "ok",
      done: true,
    };
    const rendered = renderItemLines(item, {
      width: 100,
      thinkingExpanded: false,
      outputExpanded: false,
      running: false,
    }).join("\n");
    expect(rendered).toContain("command:");
    expect(rendered).toContain("whoami");
    expect(rendered).toContain("output:");
    expect(rendered).toContain("aniketpandey");
  });

  it("keeps provider error rows readable in warning notices", () => {
    const rendered = renderItemLines(
      {
        kind: "notice",
        id: "n-provider",
        level: "warn",
        text: "No provider could complete the request.\n\nProvider      Error\n------------  -----\nagentrouter  HTTP 401 unauthorized",
        done: true,
      },
      {
        width: 80,
        thinkingExpanded: false,
        outputExpanded: false,
        running: false,
      },
    ).join("\n");
    expect(rendered).toContain("WARN");
    expect(rendered).toContain("Provider      Error");
    expect(rendered).toContain("agentrouter  HTTP 401 unauthorized");
  });
});

describe("evaluateTui gating", () => {
  it("requires both stdio ends to be TTYs", () => {
    expect(evaluateTui({ stdoutIsTTY: false, stdinIsTTY: true, columns: 100, rows: 40 }).ok).toBe(false);
    expect(evaluateTui({ stdoutIsTTY: true, stdinIsTTY: false, columns: 100, rows: 40 }).ok).toBe(false);
  });

  it("requires a minimum window size", () => {
    const small = evaluateTui({
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: MIN_COLS - 1,
      rows: MIN_ROWS,
    });
    expect(small.ok).toBe(false);
    expect(small.reason).toContain("too small");
  });

  it("accepts a real interactive terminal", () => {
    expect(
      evaluateTui({ stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }).ok,
    ).toBe(true);
  });
});

describe("TUI compaction transcript", () => {
  it("includes intentions, tool commands, status, output, and artifacts", () => {
    const source = serializeTranscriptForCompaction([
      { kind: "user", id: "u", text: "find open ports", done: true },
      {
        kind: "tool", id: "t", name: "net.scan", argsDisplay: "127.0.0.1",
        output: "5000/tcp open", status: "ok", exitCode: 0,
        artifactPath: "/tmp/nmap.txt", done: true,
      },
    ]);
    expect(source).toContain("USER INTENT/PROMPT:\nfind open ports");
    expect(source).toContain("TOOL/COMMAND: net.scan");
    expect(source).toContain("STATUS: ok (exit 0)");
    expect(source).toContain("5000/tcp open");
    expect(source).toContain("FULL ARTIFACT: /tmp/nmap.txt");
  });

  it("handles serialization of compacted items", () => {
    const source = serializeTranscriptForCompaction([
      { kind: "compacted", id: "c", summary: "Previously did task X", originalItems: [], done: true },
    ]);
    expect(source).toContain("COMPACTED CONTEXT:\nPreviously did task X");
  });
});

describe("TUI compaction reducer and rendering", () => {
  it("appends a compacted block to visual items", () => {
    let state = initialState();
    state.items = [
      { kind: "user", id: "u1", text: "query 1", done: true },
      { kind: "assistant", id: "a1", text: "response 1", streaming: false, done: true },
      { kind: "user", id: "u2", text: "query 2", done: true },
      { kind: "assistant", id: "a2", text: "response 2", streaming: false, done: true },
    ];

    state = reducer(state, { type: "compacted", summary: "Compacted memory", keepRecent: 2 });
    expect(state.items).toHaveLength(5);
    expect(state.items[4]!.kind).toBe("compacted");
    expect((state.items[4] as any).summary).toBe("Compacted memory");
  });

  it("renders compacted item with spoiler and full view on toggle", () => {
    const item = {
      kind: "compacted" as const,
      id: "c1",
      summary: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8",
      originalItems: [],
      done: true,
    };

    const renderedCollapsed = renderItemLines(item, {
      width: 80,
      thinkingExpanded: false,
      outputExpanded: false,
      running: false,
    });
    expect(renderedCollapsed.join("\n")).toContain("✦ Compacted Context");
    expect(renderedCollapsed.join("\n")).toContain("+2 more line(s)");

    const renderedExpanded = renderItemLines(item, {
      width: 80,
      thinkingExpanded: false,
      outputExpanded: true,
      running: false,
    });
    expect(stripAnsi(renderedExpanded.join("\n"))).toContain(
      "✦ Compacted Context",
    );
    expect(stripAnsi(renderedExpanded.join("\n"))).toContain("Line 4");
    expect(stripAnsi(renderedExpanded.join("\n"))).toContain("Line 5");
    expect(stripAnsi(renderedExpanded.join("\n"))).toContain("expanded · ctrl+o");
  });
});
