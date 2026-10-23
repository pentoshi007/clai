import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { NativeToolCall } from "../../src/types.js";
import { createStreamSession, type StreamSession } from "../../src/agent/turn/loop/stream-session.js";
import { syncNativeToolCallCards } from "../../src/agent/turn/loop/native-tool-calls.js";
import { formatToolArgs } from "../../src/agent/tool-call-parser.js";
import { AgentEventAdapter } from "../../src/app/adapters/agent-event-adapter.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { asSessionId, asTurnId } from "../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import { TranscriptStore } from "../../src/ui-core/state/transcript-store.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import { serializeForHistory } from "../../src/ui-core/state/transcript-hydrate.js";

const sessions: StreamSession[] = [];
const stores: TranscriptStore[] = [];

function harness() {
  const events: AgentEvent[] = [];
  const store = new TranscriptStore();
  stores.push(store);
  const sequencer = new EventSequencer(asSessionId("pending"), createCountingIdFactory(), { now: () => Date.now() });
  const adapter = new AgentEventAdapter(sequencer, new OutputSpool(), event => store.dispatch(event));
  adapter.setTurn(asTurnId("turn-1"));
  const emit = (event: AgentEvent): void => { events.push(event); adapter.ingest(event); };
  let counter = 0;
  const allocate = () => `tool-${++counter}`;
  const writeToolCall = (id: string, call: { name: string; args: Record<string, unknown> }) =>
    emit({ type: "tool-call", id, name: call.name, argsDisplay: formatToolArgs(call) });
  const session = createStreamSession({
    emitStatus: text => emit({ type: "status", text }),
    emitAssistantDelta: text => emit({ type: "assistant-delta", text }),
    emitThinkingDelta: text => emit({ type: "thinking-delta", text }),
    writePendingToolCall: (id, name) => emit({ type: "tool-call-pending", id, name }),
    writeToolBlocked: (id, name, reason) => emit({ type: "tool-blocked", id, name, reason }),
    writeStatus: vi.fn(), notify: vi.fn(), writeToolCall,
    nextToolEventId: allocate, markPrinted: vi.fn(), nativeToolsAttached: () => true,
    onSuccessfulRequest: vi.fn(),
  });
  sessions.push(session);
  const items = () => transcriptItems(store.getState());
  const tools = () => items().filter(item => item.kind === "tool");
  const complete = (calls: NativeToolCall[]) => {
    session.finishToolCalls(calls);
    syncNativeToolCallCards({
      deferredToolCalls: session.deferredToolCalls, callIds: session.callIds,
      allocateEventId: allocate, markPrinted: vi.fn(),
    }, calls);
    for (const entry of session.deferredToolCalls) writeToolCall(entry.eventId, entry.call);
  };
  return { events, emit, session, store, items, tools, complete };
}

const native = (id: string, name: string, args: Record<string, unknown> = {}): NativeToolCall => ({ id, name, args });

afterEach(() => {
  for (const session of sessions.splice(0)) session.stopHeartbeat();
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

it("shows a queued skeleton and stops thinking before any arguments complete", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const h = harness();
  h.session.onStreamEvent({ type: "reasoning_delta", text: "Checking the file" });
  vi.setSystemTime(2_500);
  h.session.onToolCallDelta({ index: 0, id: "wire-1", name: "fs__read", argumentsBytes: 1 });
  expect(h.tools()).toMatchObject([{ name: "fs.read", argsDisplay: "", status: "queued", pending: true }]);
  expect(h.items().find(item => item.kind === "thinking")).toMatchObject({ streaming: false, endedAt: 2_500 });
  expect(h.store.getState().pendingThinkingId).toBeUndefined();
  vi.advanceTimersByTime(30_000);
  expect(h.store.getState().runningStatus).toBe("fs.read");
  expect(h.items().find(item => item.kind === "thinking")).toMatchObject({ endedAt: 2_500 });
});

it("upgrades one card in place, then starts execution with complete arguments", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, id: "wire-1", name: "shell.exec" });
  const id = h.tools()[0]?.id;
  h.session.onToolCallDelta({ index: 0, name: "shell.exec", argumentsBytes: 40 });
  h.complete([native("wire-1", "shell.exec", { command: "printf ready" })]);
  expect(h.tools()).toHaveLength(1);
  expect(h.tools()[0]).toMatchObject({ id, argsDisplay: "printf ready", pending: false, status: "queued" });
  h.emit({ type: "tool-start", id: "tool-1" });
  expect(h.tools()[0]).toMatchObject({ id, status: "running" });
  h.emit({ type: "tool-result", id: "tool-1", ok: true, summary: "ready" });
  expect(h.tools()[0]).toMatchObject({ id, status: "ok", summary: "ready" });
});

it("deduplicates typed and legacy signals without rendering argument bytes", () => {
  const h = harness();
  h.session.onStreamEvent({ type: "tool_call_started", index: 0, id: "wire-1", name: "fs.write" });
  h.session.onToolCallDelta({ index: 0, id: "wire-1", name: "fs.write", argumentsBytes: 0 });
  for (let index = 0; index < 1_000; index += 1) {
    h.session.onStreamEvent({ type: "tool_arguments_delta", index: 0, argumentsBytes: index });
  }
  expect(h.tools()).toHaveLength(1);
  expect(h.events.filter(event => event.type === "tool-call-pending")).toHaveLength(1);
  expect(h.events.filter(event => event.type === "status")).toHaveLength(1);
  expect(h.items().filter(item => item.kind === "assistant")).toEqual([]);
  expect(h.tools()[0]).toMatchObject({ argsDisplay: "", pending: true });
});

it("handles sparse parallel indexes and reconciles by wire id", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 8, id: "second", name: "fs.read" });
  h.session.onToolCallDelta({ index: 3, id: "first", name: "fs.read" });
  const ids = h.tools().map(item => item.toolCallId);
  h.complete([native("first", "fs.read", { path: "first.ts" }), native("second", "fs.read", { path: "second.ts" })]);
  expect(h.tools()).toHaveLength(2);
  expect(h.tools().map(item => item.toolCallId)).toEqual(ids);
  expect(h.tools().map(item => item.argsDisplay)).toEqual(["second.ts", "first.ts"]);
});

it("reconciles transports without wire ids in stream-index order", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 8, name: "fs.read" });
  h.session.onToolCallDelta({ index: 3, name: "shell.exec" });
  h.complete([native("first", "shell.exec", { command: "echo first" }), native("second", "fs.read", { path: "second.ts" })]);
  expect(h.tools().map(item => item.argsDisplay)).toEqual(["second.ts", "echo first"]);
});

it("settles abandoned previews when a stream completes without calls", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, name: "fs.write", argumentsBytes: 40 });
  h.session.finishToolCalls([]);
  expect(h.tools()[0]).toMatchObject({ status: "blocked", pending: false });
  expect(h.tools()[0]?.reason).toMatch(/Nothing ran/);
  expect(h.session.callIds).toEqual([]);
});

it("discards previews on failure and allocates fresh ids for a retry", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, id: "failed", name: "fs.write" });
  h.session.finishToolCalls();
  expect(h.tools()[0]).toMatchObject({ status: "blocked", pending: false });
  h.complete([native("retry", "fs.read", { path: "retry.ts" })]);
  expect(h.tools()).toHaveLength(2);
  expect(h.tools()[1]?.toolCallId).not.toBe(h.tools()[0]?.toolCallId);
});

it("settles a preview that was suppressed before execution on the next model round", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, id: "wire-1", name: "fs.write" });
  h.session.finishToolCalls([native("wire-1", "fs.write", { path: "ignored.ts" })]);
  h.emit({ type: "status", text: "step 2" });
  expect(h.tools()[0]).toMatchObject({ status: "blocked", pending: false });
});

it.each(["turn-aborted", "turn-error"] as const)("settles pending previews on %s", type => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, name: "shell.exec" });
  h.emit(type === "turn-error" ? { type, message: "stream failed" } : { type });
  expect(h.tools()[0]).toMatchObject({ status: "blocked", pending: false });
});

it("keeps quiet metadata tools hidden and ends their thinking span", () => {
  const h = harness();
  h.session.onStreamEvent({ type: "reasoning_delta", text: "Updating the plan" });
  h.session.onToolCallDelta({ index: 0, name: "task.update" });
  expect(h.tools()).toEqual([]);
  expect(h.items().find(item => item.kind === "thinking")).toMatchObject({ streaming: false });
});

it("does not create placeholders for unnamed or invalid stream indexes", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, argumentsBytes: 10 });
  h.session.onToolCallDelta({ index: -1, name: "fs.read" });
  h.session.onToolCallDelta({ index: Number.NaN, name: "fs.read" });
  expect(h.tools()).toEqual([]);
});

it("never leaks chunked text-tool syntax into assistant rows beside a pending native card", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, name: "shell.exec" });
  for (const token of ["`", "``to", "ol\n", '{"name":"shell.exec","args":', '{"command":"do-not-print-this"}}', "```\n"]) {
    h.session.onToken(token);
    for (const item of h.items()) {
      if (item.kind === "assistant") expect(item.text).not.toMatch(/shell\.exec|do-not-print-this|"args"|```/);
    }
  }
});


it("never records an incomplete preview as a successful historical tool", () => {
  const h = harness();
  h.session.onToolCallDelta({ index: 0, name: "fs.write" });
  expect(serializeForHistory(h.store.getState(), () => "")).toEqual([]);
  h.session.finishToolCalls();
  expect(serializeForHistory(h.store.getState(), () => "")).toMatchObject([{ kind: "tool", status: "blocked" }]);
});

it("preserves the final reasoning block without adding a duplicate after a pending call", () => {
  const h = harness();
  h.session.onStreamEvent({ type: "reasoning_delta", text: "Planning the call" });
  h.session.onToolCallDelta({ index: 0, name: "fs.read" });
  h.emit({ type: "thinking-block", content: "Planning the call" });
  expect(h.items().filter(item => item.kind === "thinking")).toHaveLength(1);
});
