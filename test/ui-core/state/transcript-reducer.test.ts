import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
  type AnyAppEvent,
} from "../../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../../src/app/events/sequencer.js";
import {
  applyAppEvent,
  TranscriptSequenceError,
} from "../../../src/ui-core/state/transcript-reducer.js";
import {
  compactionTokenLabel,
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type AssistantItem,
  type CompactedItem,
  type ThinkingItem,
  type ToolItem,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";
import { normalizeSemanticDocument } from "../../../src/ui-core/state/semantic-document.js";
import { extractTranscriptSemanticDocument } from "../../../src/ui-core/rendering/transcript-semantic.js";
import { turnSummaryLabel } from "../../../src/ui-core/rendering/duration.js";

function fold(events: readonly AnyAppEvent[]): TranscriptState {
  return events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
}

function buildSequencer(prefix = "") {
  return new EventSequencer(
    asSessionId("sess-1"),
    createCountingIdFactory(prefix),
    { now: () => 1_700_000_000_000 },
  );
}

describe("transcript reducer (V2-050)", () => {
  it("creates a user item from turn-started", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [seq.build("turn-started", { prompt: "hello" }, turnId)];
    const state = fold(events);
    expect(state.order).toHaveLength(1);
    const item = transcriptItems(state)[0];
    expect(item).toMatchObject({ kind: "user", text: "hello" });
  });

  it("hides turn-started when displayPrompt is null (implement/revision directives)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [
      seq.build(
        "turn-started",
        {
          prompt: "Plan approved. Execute it. Work through pending tasks…",
          displayPrompt: null,
        },
        turnId,
      ),
    ];
    const state = fold(events);
    expect(state.order).toHaveLength(0);
  });

  it("shows short displayPrompt instead of full model prompt for plan revisions", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [
      seq.build(
        "turn-started",
        {
          prompt: "Plan revision request from the user…\nUser feedback:\nuse glassmorphism",
          displayPrompt: "use glassmorphism",
        },
        turnId,
      ),
    ];
    const state = fold(events);
    expect(transcriptItems(state)[0]).toMatchObject({
      kind: "user",
      text: "use glassmorphism",
    });
  });

  it("coalesces assistant deltas into one streaming item, then finalizes on assistant-message", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events: AnyAppEvent[] = [
      seq.build("assistant-delta", { text: "Hel" }, turnId),
      seq.build("assistant-delta", { text: "lo" }, turnId),
    ];
    const streaming = fold(events);
    expect(streaming.order).toHaveLength(1);
    const pending = streaming.byId.get(streaming.pendingAssistantId!) as AssistantItem;
    expect(pending).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });

    const final = applyAppEvent(
      streaming,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hello!" }, turnId),
    );
    expect(final.order).toHaveLength(1);
    expect(final.pendingAssistantId).toBeUndefined();
    const item = final.byId.get(final.order[0]!) as AssistantItem;
    expect(item).toMatchObject({ text: "Hello!", streaming: false });
  });

  it("starts a new assistant item after finalization (multi-step turn)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "First" }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "First" }, turnId),
    );
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "Second" }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "Second" }, turnId),
    );
    const items = transcriptItems(state) as AssistantItem[];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text)).toEqual(["First", "Second"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });

  it("finalizes a thinking-block with no preceding deltas", () => {
    const seq = buildSequencer();
    const state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "reasoning" }, undefined),
    );
    const item = transcriptItems(state)[0] as ThinkingItem;
    expect(item).toMatchObject({ kind: "thinking", content: "reasoning", streaming: false });
  });

  it("merges a resumed thinking round into the dropped block it continues", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "first pass " }, turnId));
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "reasoning" }, turnId));
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "first pass reasoning" },
        turnId,
      ),
    );
    expect(transcriptItems(state)).toHaveLength(1);

    state = applyAppEvent(state, seq.build("thinking-delta", { text: "resumed pass" }, turnId));
    expect(transcriptItems(state)).toHaveLength(1);
    expect(state.pendingThinkingId).toBe(state.order[0]);

    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "resumed pass" },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "thinking",
      content: "first pass reasoning\n\nresumed pass",
      streaming: false,
    });
  });

  it("merges consecutive buffered thinking-blocks of one turn into a single item", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "round one" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "round two" }, turnId),
    );
    const items = transcriptItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "thinking",
      content: "round one\n\nround two",
      streaming: false,
    });
  });

  it("keeps thinking blocks separated by a tool entry distinct", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "plan the call" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "src/index.ts" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "read the result" }, turnId),
    );
    const kinds = transcriptItems(state).map((i) => i.kind);
    expect(kinds).toEqual(["thinking", "tool", "thinking"]);
  });

  it("does not merge thinking blocks across turn boundaries", () => {
    const seq = buildSequencer();
    const turnOne = asTurnId("turn-1");
    const turnTwo = asTurnId("turn-2");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "turn one" }, turnOne),
    );
    state = applyAppEvent(
      state,
      seq.build("turn-started", { prompt: "backend directive", displayPrompt: null }, turnTwo),
    );
    state = applyAppEvent(
      state,
      seq.build("thinking-block", { messageId: seq.ids.message(), content: "turn two" }, turnTwo),
    );
    const items = transcriptItems(state);
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i as ThinkingItem).content)).toEqual(["turn one", "turn two"]);
  });

  it("discards unfinalized assistant stream when a tool-call arrives (no tool JSON as Response)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: '```tool\n{"name":"fs.read","args":{}}\n```' }, turnId),
    );
    expect(state.pendingAssistantId).toBeDefined();
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "{}" },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "fs.read" });
    expect(state.pendingAssistantId).toBeUndefined();
    expect(state.runningStatus).toBe("preparing tools");
  });

  it("keeps finalized Response prose above the tool card", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "Checking…" }, turnId));
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Checking your interfaces." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "net.context", argsDisplay: "{}" },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect((items[0] as AssistantItem).text).toBe("Checking your interfaces.");
  });

  it("keeps late thinking after the assistant response that preceded it", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "Let me batch these." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Good — recon summary." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "I should run http.fetch and dns.lookup." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        {
          toolCallId: asToolCallId("c1"),
          name: "tool.batch",
          argsDisplay: "4 call(s): http.fetch, dns.lookup",
        },
        turnId,
      ),
    );
    const kinds = transcriptItems(state).map((i) => i.kind);
    expect(kinds).toEqual(["assistant", "thinking", "tool"]);
    expect((transcriptItems(state)[0] as AssistantItem).text).toMatch(/recon/);
    expect((transcriptItems(state)[1] as ThinkingItem).content).toMatch(/http\.fetch/);
  });

  it("preserves each response and late thinking block in multi-step turns", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("turn-started", { prompt: "hi" }, turnId),
    );

    // Step 1: response then late thinking-block
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Hey! I'm clai." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-1 greeting" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("notice", { level: "warn", text: "described a web action…" }, turnId),
    );

    // Step 2
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "I didn't promise a fetch." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-2 clarify" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("notice", { level: "warn", text: "described a web action…" }, turnId),
    );

    // Step 3
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Give me a real topic." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "think-3 refuse" },
        turnId,
      ),
    );

    const items = transcriptItems(state);
    const summary = items.map((i) => {
      if (i.kind === "thinking") return `T:${(i as ThinkingItem).content}`;
      if (i.kind === "assistant") return `A:${(i as AssistantItem).text.slice(0, 12)}`;
      if (i.kind === "notice") return "N";
      if (i.kind === "user") return "U";
      return i.kind;
    });
    // Notices between steps are toast-only and do not appear as chat rows.
    expect(summary).toEqual([
      "U",
      "A:Hey! I'm cla",
      "T:think-1 greeting",
      "A:I didn't pro",
      "T:think-2 clarify",
      "A:Give me a re",
      "T:think-3 refuse",
    ]);
  });

  it("hoists a late thinking-delta above an assistant row that has painted nothing", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    // Fence-only delta holds an empty placeholder row — nothing is on screen yet.
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "```tool\n" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-delta",
        { text: "The user wants me to continue; I should provide a final summary." },
        turnId,
      ),
    );
    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
    ]);
  });

  it("hoists a turn's only thinking row above the answer it produced", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "Assessment complete. Risk: LOW." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-delta",
        { text: "The user wants me to continue; I should provide a final summary." },
        turnId,
      ),
    );
    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
    ]);
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        {
          messageId: seq.ids.message(),
          content: "The user wants me to continue; I should provide a final summary.",
        },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        {
          messageId: seq.ids.message(),
          text: "Assessment complete. Risk: LOW.",
        },
        turnId,
      ),
    );
    const items = transcriptItems(state);
    expect(items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
    expect((items[0] as ThinkingItem).content).toMatch(/final summary/);
    expect((items[0] as ThinkingItem).streaming).toBe(false);
    expect((items[1] as AssistantItem).text).toMatch(/Risk: LOW/);
  });

  it("keeps pre-tool prose open through preview and closes it when execution starts", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "I'll inspect the config." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "config.json" },
        turnId,
      ),
    );
    expect(state.pendingAssistantId).toBeDefined();
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-delta",
        { text: " Checking the active value." },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-started",
        { toolCallId: asToolCallId("c1") },
        turnId,
      ),
    );
    expect(state.pendingAssistantId).toBeUndefined();
    state = applyAppEvent(
      state,
      seq.build(
        "tool-result",
        { toolCallId: asToolCallId("c1"), ok: true, summary: "read" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "The setting is enabled." }, turnId),
    );

    const items = transcriptItems(state);
    expect(items.map((item) => item.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect((items[0] as AssistantItem).text).toBe(
      "I'll inspect the config. Checking the active value.",
    );
    expect((items[0] as AssistantItem).streaming).toBe(false);
    expect((items[2] as AssistantItem).text).toBe("The setting is enabled.");
  });

  it("keeps streaming thinking after the previous response (multi-step deltas)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "plan-1" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "plan-1" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "First reply" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "plan-2" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        { messageId: seq.ids.message(), content: "plan-2" },
        turnId,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "Second reply" },
        turnId,
      ),
    );
    const kinds = transcriptItems(state).map((i) => {
      if (i.kind === "thinking") return `T:${(i as ThinkingItem).content}`;
      if (i.kind === "assistant") return `A:${(i as AssistantItem).text}`;
      return i.kind;
    });
    expect(kinds).toEqual([
      "T:plan-1",
      "A:First reply",
      "T:plan-2",
      "A:Second reply",
    ]);
  });

  it("closes streaming thinking when a tool-call arrives", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("thinking-delta", { text: "planning…" }, turnId),
    );
    expect(state.pendingThinkingId).toBeDefined();
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "sysinfo", argsDisplay: "" },
        turnId,
      ),
    );
    expect(state.pendingThinkingId).toBeUndefined();
    const thinking = transcriptItems(state).find((i) => i.kind === "thinking") as ThinkingItem;
    expect(thinking.streaming).toBe(false);
  });

  it("sets runningStatus for thinking / responding / tool name", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("thinking-delta", { text: "hmm" }, turnId),
    );
    expect(state.runningStatus).toBe("thinking");
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "hi" }, turnId));
    expect(state.runningStatus).toBe("responding");
  });

  it("runs a tool call through call -> output -> result", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a.ts" }, undefined),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-output",
        { ref: { toolCallId: asToolCallId("c1"), chunkBytes: 5, totalBytes: 5 } },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "tool-result",
        { toolCallId: asToolCallId("c1"), ok: true, exitCode: 0, summary: "done", artifactPath: undefined },
        undefined,
      ),
    );
    const item = transcriptItems(state)[0] as ToolItem;
    expect(item).toMatchObject({
      kind: "tool",
      status: "ok",
      exitCode: 0,
      summary: "done",
      outputBytes: 5,
    });
  });

  it("marks a tool blocked", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "shell.exec", argsDisplay: "rm -rf" }, undefined),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-blocked", { toolCallId: asToolCallId("c1"), name: "shell.exec", reason: "unsafe" }, undefined),
    );
    const item = transcriptItems(state)[0] as ToolItem;
    expect(item).toMatchObject({ status: "blocked", reason: "unsafe" });
  });

  it("gives repeated legacy tool ids unique transcript rows", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "first" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-blocked", { toolCallId: asToolCallId("tool-1"), name: "fs.read", reason: "interrupted" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "Retrying with complete arguments." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "second" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-started", { toolCallId: asToolCallId("tool-1") }, turnId),
    );

    const items = transcriptItems(state);
    const tools = items.filter((item): item is ToolItem => item.kind === "tool");
    expect(items.map((item) => item.kind)).toEqual(["tool", "assistant", "tool"]);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((item) => item.id)).size).toBe(2);
    expect(tools.map((item) => item.status)).toEqual(["blocked", "running"]);
    expect(() => normalizeSemanticDocument(extractTranscriptSemanticDocument(state))).not.toThrow();
  });

  it("refreshes a queued tool card in place when the runner learns the real args", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "src/a.ts  lines 1–40" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-started", { toolCallId: asToolCallId("tool-1") }, turnId),
    );

    const tools = transcriptItems(state).filter(
      (item): item is ToolItem => item.kind === "tool",
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]!.argsDisplay).toBe("src/a.ts  lines 1–40");
    expect(tools[0]!.status).toBe("running");
  });

  it("ignores chrome notices but appends compacted items", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("notice", { level: "warn", text: "careful" }, undefined));
    state = applyAppEvent(
      state,
      seq.build("compacted", { summary: "sum", beforeTokens: 100, afterTokens: 40 }, undefined),
    );
    const items = transcriptItems(state);
    // Notices are toast-only — must never become chat rows.
    expect(items.every((i) => i.kind !== "notice")).toBe(true);
    expect(items[0]).toMatchObject({ kind: "compacted", beforeTokens: 100, afterTokens: 40 });
  });

  it("streams compaction deltas into one stable card and finalizes it in place", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-started",
        { compactionId: "c1", beforeTokens: 900 },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-delta",
        { compactionId: "c1", text: "## Work\n" },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-delta",
        { compactionId: "c1", text: "- done" },
        undefined,
      ),
    );
    expect(transcriptItems(state)).toHaveLength(1);
    expect(transcriptItems(state)[0]).toMatchObject({
      id: "compacted-c1",
      summary: "## Work\n- done",
      streaming: true,
    });

    state = applyAppEvent(
      state,
      seq.build(
        "compaction-delta",
        { compactionId: "c1", text: "", replace: true },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-delta",
        { compactionId: "c1", text: "## Accepted\n- safe" },
        undefined,
      ),
    );
    expect(transcriptItems(state)[0]).toMatchObject({
      summary: "## Accepted\n- safe",
      streaming: true,
    });

    state = applyAppEvent(
      state,
      seq.build(
        "compaction-completed",
        {
          compactionId: "c1",
          summary: "## Accepted\n- safe",
          beforeTokens: 900,
          afterTokens: 300,
        },
        undefined,
      ),
    );
    expect(transcriptItems(state)).toHaveLength(1);
    expect(transcriptItems(state)[0]).toMatchObject({
      id: "compacted-c1",
      streaming: false,
      beforeTokens: 900,
      afterTokens: 300,
    });
  });

  it("marks a failed compaction as retaining the original context", () => {
    const seq = buildSequencer();
    let state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build(
        "compaction-started",
        { compactionId: "c-failed", beforeTokens: 24_240 },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-failed",
        {
          compactionId: "c-failed",
          message: "model returned an empty summary",
          retainedTokens: 24_240,
        },
        undefined,
      ),
    );

    const item = transcriptItems(state)[0] as CompactedItem;
    expect(item).toMatchObject({
      id: "compacted-c-failed",
      summary: "",
      beforeTokens: 24_240,
      afterTokens: 24_240,
      streaming: false,
      error: "model returned an empty summary",
    });
    expect(compactionTokenLabel(item)).toBe(
      "~24,240 tokens · original context retained",
    );
    expect(compactionTokenLabel(item)).not.toContain("→ ~0");
  });

  it("creates a retained-context failure card when the start event was missed", () => {
    const seq = buildSequencer();
    const state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build(
        "compaction-failed",
        {
          compactionId: "late-failure",
          message: "summary rejected",
          retainedTokens: 8_000,
        },
        undefined,
      ),
    );
    expect(transcriptItems(state)[0]).toMatchObject({
      kind: "compacted",
      id: "compacted-late-failure",
      summary: "",
      beforeTokens: 8_000,
      afterTokens: 8_000,
      error: "summary rejected",
      streaming: false,
    });
  });

  it("closes an open streaming item and surfaces a notice on turn-error", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "partial" }, turnId));
    state = applyAppEvent(state, seq.build("turn-error", { message: "boom" }, turnId));
    expect(state.pendingAssistantId).toBeUndefined();
    const items = transcriptItems(state);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "partial", streaming: false });
    expect(items[1]).toMatchObject({ kind: "notice", level: "error", text: "boom" });
  });

  it("surfaces a warn notice on turn-aborted and clears runningStatus", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("status", { text: "step 1" }, undefined));
    expect(state.runningStatus).toBe("step 1");
    state = applyAppEvent(state, seq.build("turn-aborted", {}, undefined));
    expect(state.runningStatus).toBeUndefined();
    expect(transcriptItems(state).at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  it("relabels a steered abort as an info 'Prompt steered.' notice", () => {
    const seq = buildSequencer();
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("status", { text: "step 1" }, undefined));
    state = applyAppEvent(
      state,
      seq.build("turn-aborted", { reason: "steer" }, undefined),
    );
    expect(state.runningStatus).toBeUndefined();
    expect(transcriptItems(state).at(-1)).toMatchObject({
      kind: "notice",
      level: "info",
      text: "Prompt steered.",
    });
  });

  it("keeps model prose, tools, and post-tool analysis in emitted order", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "checking" }, turnId));
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "I'll inspect the config." }, turnId));
    state = applyAppEvent(
      state,
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "I'll inspect the config." }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("tool-1"), name: "fs.read", argsDisplay: "config.json" }, turnId),
    );
    state = applyAppEvent(
      state,
      seq.build("tool-result", { toolCallId: asToolCallId("tool-1"), ok: true, summary: "read" }, turnId),
    );
    state = applyAppEvent(state, seq.build("thinking-delta", { text: "interpreting" }, turnId));
    state = applyAppEvent(state, seq.build("assistant-delta", { text: "The setting is enabled." }, turnId));

    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "thinking",
      "assistant",
    ]);
  });

  it("ignores plan-updated/confirm-requested but still advances lastSequence", () => {
    const seq = buildSequencer();
    const before = EMPTY_TRANSCRIPT_STATE.lastSequence;
    const state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build("confirm-requested", { requestId: "r1", kind: "tool", prompt: "ok?" }, undefined),
    );
    expect(state.order).toHaveLength(0);
    expect(state.lastSequence).toBeGreaterThan(before);
  });

  it("is deterministic on replay given the same ids/clock", () => {
    const build = (prefix: string) => {
      const seq = new EventSequencer(asSessionId("sess-1"), createCountingIdFactory(prefix), {
        now: () => 42,
      });
      const turnId = asTurnId("turn-1");
      const events: AnyAppEvent[] = [
        seq.build("turn-started", { prompt: "go" }, turnId),
        seq.build("assistant-delta", { text: "Hi" }, turnId),
        seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hi" }, turnId),
      ];
      return fold(events);
    };
    const a = build("r-");
    const b = build("r-");
    expect(JSON.stringify([...a.byId.entries()])).toBe(JSON.stringify([...b.byId.entries()]));
    expect(a.order).toEqual(b.order);
  });
});

describe("turn summary rows", () => {
  function timedSequencer(start: number) {
    let now = start;
    const seq = new EventSequencer(
      asSessionId("sess-1"),
      createCountingIdFactory(),
      { now: () => now },
    );
    return { seq, advance: (ms: number) => { now += ms; } };
  }

  it("appends a worked-for row with the per-turn duration on turn-ended", () => {
    const { seq, advance } = timedSequencer(1_700_000_000_000);
    const turnId = asTurnId("turn-1");
    const started = seq.build("turn-started", { prompt: "hello" }, turnId);
    advance(76_000);
    const ended = seq.build("turn-ended", { finalAnswer: "done", steps: 1 }, turnId);
    const state = fold([started, ended]);
    const summary = transcriptItems(state).find((item) => item.kind === "turn-summary");
    expect(summary).toMatchObject({ kind: "turn-summary", durationMs: 76_000, status: "completed" });
    expect(state.activeTurnStartedAt).toBeUndefined();
  });

  it("marks aborted turns and keeps the abort notice", () => {
    const { seq, advance } = timedSequencer(1_700_000_000_000);
    const turnId = asTurnId("turn-1");
    const started = seq.build("turn-started", { prompt: "hello" }, turnId);
    advance(5_000);
    const aborted = seq.build("turn-aborted", {}, turnId);
    const state = fold([started, aborted]);
    const items = transcriptItems(state);
    expect(items.find((item) => item.kind === "turn-summary")).toMatchObject({ durationMs: 5_000, status: "aborted" });
    expect(items.some((item) => item.kind === "notice" && item.text === "Turn aborted.")).toBe(true);
  });

  it("marks errored turns", () => {
    const { seq, advance } = timedSequencer(1_700_000_000_000);
    const turnId = asTurnId("turn-1");
    const started = seq.build("turn-started", { prompt: "hello" }, turnId);
    advance(2_500);
    const errored = seq.build("turn-error", { message: "boom" }, turnId);
    const state = fold([started, errored]);
    expect(transcriptItems(state).find((item) => item.kind === "turn-summary")).toMatchObject({ durationMs: 2_500, status: "error" });
  });

  it("skips the row when no turn start was tracked (hydrated states)", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([seq.build("turn-ended", { finalAnswer: "done", steps: 1 }, turnId)]);
    expect(transcriptItems(state).some((item) => item.kind === "turn-summary")).toBe(false);
  });

  it("formats the label like claude code", () => {
    expect(turnSummaryLabel(76_000, "completed")).toBe("Worked for 1m16s");
    expect(turnSummaryLabel(5_000, "aborted")).toBe("Worked for 5.0s · aborted");
    expect(turnSummaryLabel(2_500, "error")).toBe("Worked for 2.5s · error");
  });
});

describe("transcript sequence policy (T620 / MR-017)", () => {
  const withSequence = (event: AnyAppEvent, sequence: number): AnyAppEvent =>
    ({ ...event, sequence }) as AnyAppEvent;

  it("fails loudly when an event arrives with a gap", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const first = seq.build("turn-started", { prompt: "hello" }, turnId);
    const skipped = seq.build("assistant-delta", { text: "never seen" }, turnId);
    const later = seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hello!" }, turnId);
    const state = fold([first]);
    expect(() =>
      applyAppEvent(state, withSequence(later, first.sequence + 2)),
    ).toThrow(TranscriptSequenceError);
    expect(() =>
      applyAppEvent(state, withSequence(skipped, first.sequence + 3)),
    ).toThrow(/transcript sequence gap: expected 2 but received 4/);
  });

  it("still ignores redelivered earlier events without throwing", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const started = seq.build("turn-started", { prompt: "hello" }, turnId);
    const delta = seq.build("assistant-delta", { text: "Hi" }, turnId);
    const state = fold([started, delta]);
    expect(applyAppEvent(state, withSequence(started, started.sequence))).toBe(state);
    expect(applyAppEvent(state, withSequence(delta, delta.sequence))).toBe(state);
    expect(state.lastSequence).toBe(delta.sequence);
  });

  it("advances one event at a time and preserves every item", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const events = [
      seq.build("turn-started", { prompt: "hello" }, turnId),
      seq.build("assistant-delta", { text: "Hel" }, turnId),
      seq.build("assistant-delta", { text: "lo!" }, turnId),
      seq.build("assistant-message", { messageId: seq.ids.message(), text: "Hello!" }, turnId),
    ];
    const state = fold(events);
    expect(state.lastSequence).toBe(events.length);
    expect(transcriptItems(state).map((item) => item.kind)).toEqual([
      "user",
      "assistant",
    ]);
    let stepped = fold(events.slice(0, 1));
    for (const event of events.slice(1)) {
      stepped = applyAppEvent(stepped, event);
    }
    expect(stepped).toEqual(state);
  });
});

describe("thinking and compaction lifecycle timing", () => {
  it("preserves a thinking start across reopen and freezes each close", () => {
    let now = 1_000;
    const seq = new EventSequencer(
      asSessionId("sess-thinking-timer"),
      createCountingIdFactory("timer-thinking-"),
      { now: () => now },
    );
    const turnId = asTurnId("turn-thinking-timer");
    let state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build(
        "thinking-delta",
        { text: "first", reasoningId: "reasoning-timer" },
        turnId,
      ),
    );
    let thinking = transcriptItems(state)[0] as ThinkingItem;
    expect(thinking.startedAt).toBe(1_000);
    expect(thinking.endedAt).toBeUndefined();

    now = 13_000;
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-block",
        {
          messageId: seq.ids.message(),
          content: "first",
          reasoningId: "reasoning-timer",
        },
        turnId,
      ),
    );
    thinking = transcriptItems(state)[0] as ThinkingItem;
    expect(thinking.endedAt).toBe(13_000);

    now = 20_000;
    state = applyAppEvent(
      state,
      seq.build(
        "thinking-delta",
        { text: "second", reasoningId: "reasoning-timer" },
        turnId,
      ),
    );
    thinking = transcriptItems(state)[0] as ThinkingItem;
    expect(thinking.startedAt).toBe(1_000);
    expect(thinking.endedAt).toBeUndefined();
    expect(thinking.streaming).toBe(true);

    now = 25_000;
    state = applyAppEvent(
      state,
      seq.build("assistant-delta", { text: "answer" }, turnId),
    );
    thinking = transcriptItems(state)[0] as ThinkingItem;
    expect(thinking.startedAt).toBe(1_000);
    expect(thinking.endedAt).toBe(25_000);
    expect(thinking.streaming).toBe(false);
  });

  it("preserves a compaction start through completion and retry failure", () => {
    let now = 2_000;
    const seq = new EventSequencer(
      asSessionId("sess-compaction-timer"),
      createCountingIdFactory("timer-compaction-"),
      { now: () => now },
    );
    let state = applyAppEvent(
      EMPTY_TRANSCRIPT_STATE,
      seq.build(
        "compaction-started",
        { compactionId: "timer", beforeTokens: 90_000 },
        undefined,
      ),
    );

    now = 17_000;
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-completed",
        {
          compactionId: "timer",
          summary: "memory",
          beforeTokens: 90_000,
          afterTokens: 20_000,
          contextScope: "assembled-request",
        },
        undefined,
      ),
    );
    let compacted = transcriptItems(state)[0] as CompactedItem;
    expect(compacted.timestamp).toBe(2_000);
    expect(compacted.startedAt).toBe(2_000);
    expect(compacted.endedAt).toBe(17_000);

    now = 20_000;
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-started",
        { compactionId: "timer", beforeTokens: 90_000 },
        undefined,
      ),
    );
    compacted = transcriptItems(state)[0] as CompactedItem;
    expect(compacted.startedAt).toBe(2_000);
    expect(compacted.endedAt).toBeUndefined();

    now = 29_000;
    state = applyAppEvent(
      state,
      seq.build(
        "compaction-failed",
        {
          compactionId: "timer",
          message: "retry failed",
          retainedTokens: 90_000,
        },
        undefined,
      ),
    );
    compacted = transcriptItems(state)[0] as CompactedItem;
    expect(compacted.startedAt).toBe(2_000);
    expect(compacted.endedAt).toBe(29_000);
  });
});
