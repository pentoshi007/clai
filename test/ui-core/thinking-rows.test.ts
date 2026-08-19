import { describe, expect, it } from "vitest";

import { applyAppEvent } from "../../src/ui-core/state/transcript-reducer.js";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
  type AnyAppEvent,
  type AppEventPayloads,
  type AppEventType,
} from "../../src/app/events/app-event.js";
import {
  createCountingIdFactory,
  EventSequencer,
} from "../../src/app/events/sequencer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type ThinkingItem,
  type TranscriptState,
} from "../../src/ui-core/state/transcript-types.js";

const TURN = asTurnId("turn-thinking-rows");

function build(): <T extends AppEventType>(
  type: T,
  payload: AppEventPayloads[T],
) => AnyAppEvent {
  const sequencer = new EventSequencer(
    asSessionId("sess-thinking-rows"),
    createCountingIdFactory("t-"),
    { now: () => 1_700_000_000_000 },
  );
  return (type, payload) => sequencer.build(type, payload, TURN);
}

function run(
  make: (
    event: <T extends AppEventType>(
      type: T,
      payload: AppEventPayloads[T],
    ) => AnyAppEvent,
  ) => readonly AnyAppEvent[],
): TranscriptState {
  return make(build()).reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
}

function thinkingRows(state: TranscriptState): ThinkingItem[] {
  return state.order
    .map((id) => state.byId.get(id))
    .filter((item): item is ThinkingItem => item?.kind === "thinking");
}

function kinds(state: TranscriptState): string[] {
  return state.order.map((id) => state.byId.get(id)?.kind ?? "missing");
}

describe("thinking rows are owned by a reasoning id, not guessed by suffix", () => {
  it("keeps one row for reasoning then content", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "step one ", reasoningId: "reasoning-1" }),
      event("thinking-delta", { text: "step two", reasoningId: "reasoning-1" }),
      event("thinking-block", {
        messageId: "m1" as never,
        content: "step one step two",
        reasoningId: "reasoning-1",
      }),
      event("assistant-delta", { text: "the answer" }),
      event("assistant-message", { messageId: "m2" as never, text: "the answer" }),
    ]);
    expect(thinkingRows(state)).toHaveLength(1);
    expect(thinkingRows(state)[0]?.content).toBe("step one step two");
  });

  it("opens a new row when reasoning arrives after non-empty prose", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "first", reasoningId: "reasoning-1" }),
      event("thinking-block", {
        messageId: "m1" as never,
        content: "first",
        reasoningId: "reasoning-1",
      }),
      event("assistant-delta", { text: "partial answer" }),
      event("thinking-delta", { text: "second", reasoningId: "reasoning-2" }),
      event("thinking-block", {
        messageId: "m2" as never,
        content: "second",
        reasoningId: "reasoning-2",
      }),
    ]);
    const rows = thinkingRows(state);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content)).toEqual(["first", "second"]);
    expect(kinds(state)).toEqual(["thinking", "assistant", "thinking"]);
  });

  it("keeps reasoning, tool, reasoning as two distinct rows", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "before", reasoningId: "reasoning-1" }),
      event("tool-call", {
        toolCallId: asToolCallId("call-1"),
        name: "fs.read",
        argsDisplay: "{}",
      }),
      event("thinking-delta", { text: "after", reasoningId: "reasoning-2" }),
      event("thinking-block", {
        messageId: "m1" as never,
        content: "after",
        reasoningId: "reasoning-2",
      }),
    ]);
    const rows = thinkingRows(state);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content)).toEqual(["before", "after"]);
  });

  it("finalizes into one row when the block is not a suffix of the deltas", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "raw streamed text", reasoningId: "reasoning-1" }),
      event("thinking-block", {
        messageId: "m1" as never,
        content: "a cleaned up summary that shares no suffix",
        reasoningId: "reasoning-1",
      }),
    ]);
    const rows = thinkingRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("a cleaned up summary that shares no suffix");
    expect(rows[0]?.streaming).toBe(false);
  });

  it("does not merge a later span into an earlier finalized row", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "one", reasoningId: "reasoning-1" }),
      event("thinking-block", {
        messageId: "m1" as never,
        content: "one",
        reasoningId: "reasoning-1",
      }),
      event("thinking-delta", { text: "two", reasoningId: "reasoning-2" }),
    ]);
    const rows = thinkingRows(state);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content)).toEqual(["one", "two"]);
  });

  it("puts a private-reasoning note above the response it describes", () => {
    const state = run((event) => [
      event("assistant-delta", { text: "Hey! I'm clai." }),
      event("thinking-delta", {
        text: "Reasoning is private on Meta Model API: the model reasoned at xhigh effort and used 78 reasoning tokens, but the API returns no reasoning text to display.",
        reasoningId: "reasoning-1",
      }),
      event("assistant-message", {
        messageId: "m1" as never,
        text: "Hey! I'm clai.",
      }),
    ]);
    expect(kinds(state)).toEqual(["thinking", "assistant"]);
    expect(thinkingRows(state)[0]?.content).toContain("private on Meta Model API");
  });

  it("still hoists over an empty assistant placeholder", () => {
    const state = run((event) => [
      event("thinking-delta", { text: "thought", reasoningId: "reasoning-1" }),
      event("assistant-delta", { text: "" }),
      event("thinking-delta", { text: " more", reasoningId: "reasoning-1" }),
    ]);
    expect(thinkingRows(state)).toHaveLength(1);
    expect(thinkingRows(state)[0]?.content).toBe("thought more");
  });
});
