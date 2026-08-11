import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asTurnId,
  type AnyAppEvent,
} from "../../../src/app/events/app-event.js";
import {
  createCountingIdFactory,
  EventSequencer,
} from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/ui-core/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type ThinkingItem,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";

function fold(events: readonly AnyAppEvent[]): TranscriptState {
  return events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
}

function buildSequencer() {
  return new EventSequencer(
    asSessionId("sess-1"),
    createCountingIdFactory(""),
    { now: () => 1_700_000_000_000 },
  );
}

describe("interleaved reasoning", () => {
  it("opens a new thinking block when reasoning resumes after the answer", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([
      seq.build("turn-started", { prompt: "go" }, turnId),
      seq.build("thinking-delta", { text: "first thought" }, turnId),
      seq.build("assistant-delta", { text: "Here is the answer. " }, turnId),
      seq.build("thinking-delta", { text: "second thought" }, turnId),
      seq.build("assistant-delta", { text: "More answer." }, turnId),
    ]);

    const kinds = transcriptItems(state).map((item) => item.kind);
    expect(kinds).toEqual(["user", "thinking", "assistant", "thinking"]);

    const thinking = transcriptItems(state).filter(
      (item): item is ThinkingItem => item.kind === "thinking",
    );
    expect(thinking.map((item) => item.content)).toEqual([
      "first thought",
      "second thought",
    ]);

    const assistant = transcriptItems(state).find(
      (item) => item.kind === "assistant",
    );
    expect(assistant).toMatchObject({
      text: "Here is the answer. More answer.",
    });
  });

  it("does not back-fill resumed reasoning into the block above the answer", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([
      seq.build("turn-started", { prompt: "go" }, turnId),
      seq.build("thinking-delta", { text: "opening" }, turnId),
      seq.build("assistant-delta", { text: "Answer." }, turnId),
      seq.build("thinking-delta", { text: "later" }, turnId),
    ]);

    const first = transcriptItems(state).find(
      (item): item is ThinkingItem => item.kind === "thinking",
    );
    expect(first?.content).toBe("opening");
    expect(first?.streaming).toBe(false);
  });

  it("still hoists reasoning above an assistant row that has painted nothing", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([
      seq.build("turn-started", { prompt: "go" }, turnId),
      seq.build("assistant-delta", { text: "   " }, turnId),
      seq.build("thinking-delta", { text: "reasoning after empty row" }, turnId),
    ]);

    const kinds = transcriptItems(state).map((item) => item.kind);
    expect(kinds).toEqual(["user", "thinking", "assistant"]);
  });

  it("ignores a finalizing thinking-block that only repeats streamed reasoning", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([
      seq.build("turn-started", { prompt: "go" }, turnId),
      seq.build("thinking-delta", { text: "first thought" }, turnId),
      seq.build("assistant-delta", { text: "Answer." }, turnId),
      seq.build("thinking-delta", { text: "second thought" }, turnId),
      seq.build("assistant-message", { text: "Answer." }, turnId),
      seq.build(
        "thinking-block",
        { content: "first thought\n\nsecond thought" },
        turnId,
      ),
    ]);

    const thinking = transcriptItems(state).filter(
      (item) => item.kind === "thinking",
    );
    expect(thinking).toHaveLength(2);
  });

  it("still appends a thinking-block that carries genuinely new reasoning", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    const state = fold([
      seq.build("turn-started", { prompt: "go" }, turnId),
      seq.build("thinking-delta", { text: "streamed" }, turnId),
      seq.build("assistant-message", { text: "Answer." }, turnId),
      seq.build("thinking-block", { content: "recovered reasoning" }, turnId),
    ]);

    const thinking = transcriptItems(state).filter(
      (item): item is ThinkingItem => item.kind === "thinking",
    );
    expect(thinking.map((item) => item.content)).toEqual([
      "streamed",
      "recovered reasoning",
    ]);
  });
});
