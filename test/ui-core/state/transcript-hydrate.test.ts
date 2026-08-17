import { describe, expect, it } from "vitest";
import type { TranscriptItem as ClassicItem } from "../../../src/app/ports/transcript-item.js";
import {
  boundSessionVisualInput,
  displayCompactSummary,
  hydrateFromClassicTranscript,
  hydrateFromMessages,
  hydrateSessionVisual,
  serializeForHistory,
  transcriptLooksIncomplete,
} from "../../../src/ui-core/state/transcript-hydrate.js";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import type { TranscriptState } from "../../../src/ui-core/state/transcript-types.js";

describe("hydrateFromClassicTranscript", () => {
  it("restores user, assistant, and tool rows with spool output", () => {
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "who is uk pm", done: true },
      {
        kind: "tool",
        id: "t1",
        name: "web.search",
        argsDisplay: "uk pm",
        output: "duckduckgo: 1 result\n{}",
        status: "ok",
        exitCode: 0,
        done: true,
      },
      {
        kind: "assistant",
        id: "a1",
        text: "Keir Starmer",
        streaming: false,
        done: true,
      },
    ];
    const { state, toolOutputs } = hydrateFromClassicTranscript(classic);
    expect(state.order).toHaveLength(3);
    const items = state.order.map((id) => state.byId.get(id)!);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(toolOutputs.get(asToolCallId("t1"))).toContain("duckduckgo");
  });

  it("maps fail status to failed", () => {
    const classic: ClassicItem[] = [
      {
        kind: "tool",
        id: "t2",
        name: "shell.exec",
        argsDisplay: "false",
        output: "err",
        status: "fail",
        exitCode: 1,
        done: true,
      },
    ];
    const { state } = hydrateFromClassicTranscript(classic);
    const tool = state.byId.get("t2");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") expect(tool.status).toBe("failed");
  });
});

describe("hydrateFromMessages", () => {
  it("rebuilds user/assistant from model history when no transcript", () => {
    const { state } = hydrateFromMessages([
      { role: "system", content: "ignored" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(state.order).toHaveLength(2);
    const kinds = state.order.map((id) => state.byId.get(id)!.kind);
    expect(kinds).toEqual(["user", "assistant"]);
  });

  it("hides internal recovery user prompts from the chat UI", () => {
    const { state } = hydrateFromMessages([
      { role: "user", content: "fix the bug" },
      {
        role: "user",
        content:
          "You diagnosed an error and described the fix but called NO tool. Apply the fix now.",
        internal: true,
      },
      {
        role: "user",
        content:
          "You diagnosed an error and described the fix but called NO tool. Legacy without flag.",
      },
      { role: "assistant", content: "Fixed." },
    ]);
    const texts = state.order.map((id) => {
      const item = state.byId.get(id)!;
      return item.kind === "user" || item.kind === "assistant"
        ? (item as { text: string }).text
        : item.kind;
    });
    expect(texts).toEqual(["fix the bug", "Fixed."]);
  });

  it("hides implement directives and successful plan.create from chat hydrate", () => {
    const { state } = hydrateFromMessages([
      { role: "user", content: "recon example.com" },
      {
        role: "assistant",
        content: "Planning.",
        toolCalls: [
          {
            id: "p1",
            name: "plan.create",
            args: { goal: "big plan", tasks: ["t1"] },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "p1",
        name: "plan.create",
        content: "Plan saved",
        ok: true,
      },
      {
        role: "user",
        content:
          "Plan approved. Execute the engagement tasks. Work through pending tasks.",
      },
      { role: "assistant", content: "Starting t1." },
    ]);
    const kinds = state.order.map((id) => state.byId.get(id)!.kind);
    expect(kinds).toEqual(["user", "assistant", "assistant"]);
    const userTexts = state.order
      .map((id) => state.byId.get(id)!)
      .filter((i) => i.kind === "user")
      .map((i) => (i as { text: string }).text);
    expect(userTexts).toEqual(["recon example.com"]);
  });

  it("reconstructs tool cards from assistant toolCalls + role:tool results", () => {
    const { state, toolOutputs } = hydrateFromMessages([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          {
            id: "call_1",
            name: "fs.list",
            args: { path: "." },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "fs.list",
        content: "a.ts\nb.ts",
        ok: true,
      },
      { role: "assistant", content: "Found two files." },
    ]);
    const kinds = state.order.map((id) => state.byId.get(id)!.kind);
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(toolOutputs.get(asToolCallId("call_1"))).toContain("a.ts");
  });

  it("rebuilds fileChanges + clean path labels for write/edit tools", () => {
    const { state } = hydrateFromMessages([
      { role: "user", content: "scaffold" },
      {
        role: "assistant",
        content: "Writing.",
        toolCalls: [
          {
            id: "w1",
            name: "fs.write",
            args: {
              path: "/Users/me/todo-app/src/main.tsx",
              content: "import React from 'react'\n",
            },
          },
          {
            id: "w2",
            name: "fs.writeMany",
            args: {
              files: [
                { path: "/Users/me/todo-app/a.ts", content: "export const a = 1\n" },
                { path: "/Users/me/todo-app/b.ts", content: "export const b = 2\n" },
              ],
            },
          },
          {
            id: "e1",
            name: "fs.edit",
            args: {
              path: "/Users/me/todo-app/a.ts",
              oldText: "export const a = 1",
              newText: "export const a = 2",
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "w1",
        name: "fs.write",
        content: "Created /Users/me/todo-app/src/main.tsx",
        ok: true,
      },
      {
        role: "tool",
        toolCallId: "w2",
        name: "fs.writeMany",
        content: "Wrote 2 files",
        ok: true,
      },
      {
        role: "tool",
        toolCallId: "e1",
        name: "fs.edit",
        content: "Replaced 1 occurrence",
        ok: true,
      },
    ]);
    const tools = state.order
      .map((id) => state.byId.get(id)!)
      .filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(3);
    const write = tools[0]!;
    if (write.kind !== "tool") throw new Error("expected tool");
    expect(write.argsDisplay).toContain("main.tsx");
    expect(write.argsDisplay.startsWith("{")).toBe(false);
    expect(write.fileChanges?.length).toBe(1);
    expect(write.fileChanges![0]!.basename).toBe("main.tsx");
    expect(write.fileChanges![0]!.kind).toBe("create");
    expect(write.fileChanges![0]!.previewHunks.length).toBeGreaterThan(0);

    const many = tools[1]!;
    if (many.kind !== "tool") throw new Error("expected tool");
    expect(many.argsDisplay).toMatch(/2 file/);
    expect(many.fileChanges?.length).toBe(2);

    const edit = tools[2]!;
    if (edit.kind !== "tool") throw new Error("expected tool");
    expect(edit.fileChanges?.length).toBe(1);
    expect(edit.fileChanges![0]!.kind).toBe("edit");
  });

  it("resets lastSequence so live turns after /history are not dropped", () => {
    // Regression: hydrate used to set lastSequence = N while the session
    // sequencer rebinds to 0, so turn-started (seq 1) was ignored.
    const { state } = hydrateFromMessages([
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "another" },
      { role: "assistant", content: "reply" },
    ]);
    expect(state.order.length).toBeGreaterThan(1);
    expect(state.lastSequence).toBe(0);
  });
});

describe("hydrateSessionVisual", () => {
  it("prefers message-derived tools when classic transcript is thin", () => {
    const messages = [
      { role: "user" as const, content: "run it" },
      {
        role: "assistant" as const,
        content: "ok",
        toolCalls: [
          { id: "c1", name: "shell.exec", args: { command: "ls" } },
          { id: "c2", name: "shell.exec", args: { command: "pwd" } },
        ],
      },
      {
        role: "tool" as const,
        toolCallId: "c1",
        content: "a\nb",
        ok: true,
      },
      {
        role: "tool" as const,
        toolCallId: "c2",
        content: "/tmp",
        ok: true,
      },
    ];
    const thinClassic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "run it", done: true },
      {
        kind: "assistant",
        id: "a1",
        text: "Aborted.",
        streaming: false,
        done: true,
      },
    ];
    const hydrated = hydrateSessionVisual(thinClassic, messages);
    const toolCount = [...hydrated.state.byId.values()].filter(
      (i) => i.kind === "tool",
    ).length;
    expect(toolCount).toBe(2);
    expect(transcriptLooksIncomplete(thinClassic.length, messages)).toBe(true);
  });

  it("enriches classic tools that lost fileChanges from message tool args", () => {
    const path = "/Users/me/todo-app/src/main.tsx";
    const content = "import './index.css'\n";
    const messages = [
      { role: "user" as const, content: "write main" },
      {
        role: "assistant" as const,
        content: "ok",
        toolCalls: [
          {
            id: "chatcmpl-tool-abc",
            name: "fs.write",
            args: { path, content },
          },
        ],
      },
      {
        role: "tool" as const,
        toolCallId: "chatcmpl-tool-abc",
        name: "fs.write",
        content: `Created ${path}`,
        ok: true,
      },
    ];
    // Classic re-save after message hydrate: tool row exists but fileChanges gone
    // and argsDisplay is raw JSON (the ugly history shape from the screenshot).
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "write main", done: true },
      {
        kind: "tool",
        id: "chatcmpl-tool-abc",
        name: "fs.write",
        argsDisplay: JSON.stringify({ path, content }),
        output: `Created ${path}\n  bytes=20`,
        status: "ok",
        done: true,
      },
    ];
    const hydrated = hydrateSessionVisual(classic, messages);
    const tool = [...hydrated.state.byId.values()].find((i) => i.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind !== "tool") throw new Error("expected tool");
    expect(tool.fileChanges?.length).toBe(1);
    expect(tool.fileChanges![0]!.basename).toBe("main.tsx");
    expect(tool.argsDisplay.startsWith("{")).toBe(false);
    expect(tool.argsDisplay).toContain("main.tsx");
  });
});

describe("post-hydrate live events", () => {
  it("applies turn-started after classic hydrate (new YOU row)", async () => {
    const { applyAppEvent } = await import(
      "../../../src/ui-core/state/transcript-reducer.js"
    );
    const { asSessionId, asTurnId } = await import(
      "../../../src/app/events/app-event.js"
    );
    const { EventSequencer, createCountingIdFactory } = await import(
      "../../../src/app/events/sequencer.js"
    );

    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "old", done: true },
      { kind: "assistant", id: "a1", text: "prior", streaming: false, done: true },
    ];
    const { state: hydrated } = hydrateFromClassicTranscript(classic);
    expect(hydrated.lastSequence).toBe(0);

    const seq = new EventSequencer(
      asSessionId("sess-hist"),
      createCountingIdFactory("h"),
      { now: () => 1 },
    );
    // Mimic loadHistory rebind — sequence starts at 1 again.
    const next = applyAppEvent(
      hydrated,
      seq.build("turn-started", { prompt: "follow-up after resume" }, asTurnId("t1")),
    );
    const users = next.order
      .map((id) => next.byId.get(id)!)
      .filter((i) => i.kind === "user");
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ kind: "user", text: "follow-up after resume" });
  });
});

describe("serializeForHistory", () => {
  it("round-trips a simple transcript", () => {
    const state: TranscriptState = {
      order: ["u1", "a1"],
      byId: new Map([
        [
          "u1",
          {
            id: "u1",
            sequence: 1,
            turnId: undefined,
            timestamp: 1,
            kind: "user",
            text: "hi",
          },
        ],
        [
          "a1",
          {
            id: "a1",
            sequence: 2,
            turnId: undefined,
            timestamp: 2,
            kind: "assistant",
            text: "yo",
            streaming: false,
          },
        ],
      ]),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      lastSequence: 2,
      runningStatus: undefined,
      expandThinkingGlobal: false,
      expandOutputGlobal: false,
      itemOverrides: new Map(),
    };
    const classic = serializeForHistory(state, () => "");
    expect(classic).toHaveLength(2);
    expect(classic[0]).toMatchObject({ kind: "user", text: "hi" });
    const again = hydrateFromClassicTranscript(classic);
    expect(again.state.order).toHaveLength(2);
  });

  it("preserves failed compaction status across save and reload", () => {
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "original context", done: true },
      {
        kind: "compacted",
        id: "c-failed",
        summary: "discarded candidate",
        originalItems: [],
        done: true,
        error: "summary rejected",
        beforeTokens: 24_240,
        afterTokens: 24_240,
      },
    ];
    const hydrated = hydrateFromClassicTranscript(classic);
    expect(hydrated.state.byId.get("c-failed")).toMatchObject({
      kind: "compacted",
      error: "summary rejected",
      beforeTokens: 24_240,
      afterTokens: 24_240,
    });

    const savedAgain = serializeForHistory(hydrated.state, () => "");
    expect(savedAgain[1]).toMatchObject({
      kind: "compacted",
      error: "summary rejected",
      beforeTokens: 24_240,
      afterTokens: 24_240,
    });
  });

  it("never persists UI notices (session resumed / Ctrl+C hints)", () => {
    const state: TranscriptState = {
      order: ["u1", "n1", "a1"],
      byId: new Map([
        [
          "u1",
          {
            id: "u1",
            sequence: 1,
            turnId: undefined,
            timestamp: 1,
            kind: "user",
            text: "hi",
          },
        ],
        [
          "n1",
          {
            id: "n1",
            sequence: 2,
            turnId: undefined,
            timestamp: 2,
            kind: "notice",
            level: "info",
            text: "session resumed · 98 items · 109 model messages",
          },
        ],
        [
          "a1",
          {
            id: "a1",
            sequence: 3,
            turnId: undefined,
            timestamp: 3,
            kind: "assistant",
            text: "yo",
            streaming: false,
          },
        ],
      ]),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      lastSequence: 3,
      runningStatus: undefined,
      expandThinkingGlobal: false,
      expandOutputGlobal: false,
      itemOverrides: new Map(),
    };
    const classic = serializeForHistory(state, () => "");
    expect(classic.map((c) => c.kind)).toEqual(["user", "assistant"]);
    expect(classic.every((c) => c.kind !== "notice")).toBe(true);
  });

  it("persists turn-summary rows and restores them on resume", () => {
    const state: TranscriptState = {
      order: ["u1", "a1", "ts1"],
      byId: new Map([
        [
          "u1",
          {
            id: "u1",
            sequence: 1,
            turnId: undefined,
            timestamp: 1,
            kind: "user",
            text: "hi",
          },
        ],
        [
          "a1",
          {
            id: "a1",
            sequence: 2,
            turnId: undefined,
            timestamp: 2,
            kind: "assistant",
            text: "yo",
            streaming: false,
          },
        ],
        [
          "ts1",
          {
            id: "ts1",
            sequence: 3,
            turnId: undefined,
            timestamp: 1_755_250_000_000,
            kind: "turn-summary",
            durationMs: 76_000,
            status: "completed",
          },
        ],
      ]),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      lastSequence: 3,
      runningStatus: undefined,
      expandThinkingGlobal: false,
      expandOutputGlobal: false,
      itemOverrides: new Map(),
    };
    const classic = serializeForHistory(state, () => "");
    expect(classic.map((c) => c.kind)).toEqual(["user", "assistant", "turn-summary"]);
    expect(classic[2]).toMatchObject({
      kind: "turn-summary",
      durationMs: 76_000,
      status: "completed",
      timestamp: 1_755_250_000_000,
    });

    const again = hydrateFromClassicTranscript(classic);
    expect(again.state.order).toHaveLength(3);
    const restored = again.state.byId.get("ts1");
    expect(restored).toMatchObject({
      kind: "turn-summary",
      durationMs: 76_000,
      status: "completed",
      timestamp: 1_755_250_000_000,
    });

    const savedAgain = serializeForHistory(again.state, () => "");
    expect(savedAgain.map((c) => c.kind)).toEqual([
      "user",
      "assistant",
      "turn-summary",
    ]);
  });

  it("restores aborted turn-summary status from history", () => {
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "hi", done: true },
      {
        kind: "turn-summary",
        id: "ts2",
        durationMs: 4_200,
        status: "aborted",
        done: true,
      },
    ];
    const { state } = hydrateFromClassicTranscript(classic);
    expect(state.byId.get("ts2")).toMatchObject({
      kind: "turn-summary",
      durationMs: 4_200,
      status: "aborted",
    });
  });
});

describe("hydrateFromClassicTranscript notices", () => {
  it("drops notice rows so old history does not re-inflate item counts", () => {
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "hi", done: true },
      {
        kind: "notice",
        id: "n1",
        level: "info",
        text: "session resumed · 102 items",
        done: true,
      },
      {
        kind: "notice",
        id: "n2",
        level: "info",
        text: "Ctrl+C again to exit",
        done: true,
      },
      {
        kind: "assistant",
        id: "a1",
        text: "ok",
        streaming: false,
        done: true,
      },
    ];
    const { state } = hydrateFromClassicTranscript(classic);
    expect(state.order).toHaveLength(2);
    expect([...state.byId.values()].map((i) => i.kind)).toEqual([
      "user",
      "assistant",
    ]);
  });
});

describe("displayCompactSummary", () => {
  it("strips the session memory prefix", () => {
    expect(
      displayCompactSummary(
        "Session memory from compacted earlier turns:\n\nUser goals: ship it",
      ),
    ).toBe("User goals: ship it");
  });
});


describe("boundSessionVisualInput", () => {
  it("caps item counts, large fields, compacted sources, and tool arguments", () => {
    const transcript: ClassicItem[] = Array.from({ length: 350 }, (_, index) =>
      index === 0
        ? {
            kind: "compacted" as const,
            id: `c-${index}`,
            summary: "s".repeat(80_000),
            originalItems: [
              { kind: "user", id: "old", text: "old", done: true },
            ],
            done: true,
          }
        : {
            kind: "tool" as const,
            id: `t-${index}`,
            name: "shell.exec",
            argsDisplay: "a".repeat(80_000),
            output: "o".repeat(80_000),
            status: "ok" as const,
            done: true,
          },
    );
    const messages = Array.from({ length: 2500 }, (_, index) => ({
      role: "assistant" as const,
      content: "m".repeat(index === 2499 ? 80_000 : 20),
      toolCalls: [
        {
          id: `call-${index}`,
          name: "shell.exec",
          args: { payload: "x".repeat(80_000) },
        },
      ],
    }));

    const bounded = boundSessionVisualInput(transcript, messages);

    expect(bounded.transcript!.length).toBeLessThanOrEqual(2_000);
    expect(bounded.messages.length).toBeLessThanOrEqual(2_000);
    expect(bounded.omittedItems).toBeGreaterThan(0);
    expect(bounded.omittedMessages).toBeGreaterThan(0);
    const tool = bounded.transcript!.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" ? tool.output.length : 0).toBeLessThan(33_000);
    expect(bounded.messages.at(-1)?.content.length).toBeLessThan(33_000);
    expect(bounded.messages.at(-1)?.toolCalls?.[0]?.args).toEqual({
      restored: "Arguments available in the full session record",
    });
  });
});
