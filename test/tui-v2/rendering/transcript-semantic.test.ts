import { describe, expect, it } from "vitest";
import { asSessionId, asToolCallId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/tui-v2/state/transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/tui-v2/state/transcript-types.js";
import {
  extractTranscriptSemanticDocument,
  renderTranscriptSemanticText,
} from "../../../src/tui-v2/rendering/transcript-semantic.js";

function stateWithSentinels() {
  const sequencer = new EventSequencer(asSessionId("semantic"));
  let state = EMPTY_TRANSCRIPT_STATE;
  state = applyAppEvent(
    state,
    sequencer.build("turn-started", { prompt: "CHAT-USER-SENTINEL" }, undefined),
  );
  state = applyAppEvent(
    state,
    sequencer.build("thinking-block", { messageId: sequencer.ids.message(), content: "THINKING-SENTINEL" }, undefined),
  );
  state = applyAppEvent(
    state,
    sequencer.build("tool-call", {
      toolCallId: asToolCallId("tool-sentinel"),
      name: "fs.read",
      argsDisplay: "sentinel.txt",
    }, undefined),
  );
  state = applyAppEvent(
    state,
    sequencer.build("tool-result", {
      toolCallId: asToolCallId("tool-sentinel"),
      ok: true,
      exitCode: 0,
      summary: "CHAT-TOOL-SENTINEL",
      artifactPath: "/tmp/sentinel.txt",
    }, undefined),
  );
  state = applyAppEvent(
    state,
    sequencer.build("assistant-message", {
      messageId: sequencer.ids.message(),
      text: "CHAT-ASSISTANT-SENTINEL",
    }, undefined),
  );
  return state;
}

describe("transcript semantic extraction (V2-061)", () => {
  it("preserves normalized plain-text transcript order with exact sentinels", () => {
    const text = renderTranscriptSemanticText(stateWithSentinels(), { thinking: "none" });

    expect(text).toBe([
      "You:\nCHAT-USER-SENTINEL",
      "Tool: fs.read sentinel.txt — done (exit 0)\nCHAT-TOOL-SENTINEL\n  artifact: /tmp/sentinel.txt",
      "Assistant:\nCHAT-ASSISTANT-SENTINEL",
    ].join("\n\n"));
    expect(text.indexOf("CHAT-USER-SENTINEL")).toBeLessThan(text.indexOf("CHAT-TOOL-SENTINEL"));
    expect(text.indexOf("CHAT-TOOL-SENTINEL")).toBeLessThan(text.indexOf("CHAT-ASSISTANT-SENTINEL"));
    expect(text).not.toContain("THINKING-SENTINEL");
  });

  it("uses stable item ids and only includes visible/all thinking at the requested scope", () => {
    const state = stateWithSentinels();
    const hidden = extractTranscriptSemanticDocument(state);
    const full = extractTranscriptSemanticDocument(state, { thinking: "all" });

    // Spread Proxy arrays so vitest deep-equal compares plain values.
    const order = [...state.order];
    expect(hidden.blocks.map((block) => block.id)).toEqual(order.filter((id) => id !== order[1]));
    expect(full.blocks.map((block) => block.id)).toEqual(order);
    expect(full.blocks.map((block) => block.text).join("\n")).toContain("THINKING-SENTINEL");
  });

  it("includes supplied visible tool output without changing source order", () => {
    const text = renderTranscriptSemanticText(stateWithSentinels(), {
      thinking: "none",
      toolOutput: () => "CHAT-OUTPUT-SENTINEL",
    });
    expect(text.indexOf("CHAT-TOOL-SENTINEL")).toBeLessThan(text.indexOf("CHAT-OUTPUT-SENTINEL"));
    expect(text.indexOf("CHAT-OUTPUT-SENTINEL")).toBeLessThan(text.indexOf("CHAT-ASSISTANT-SENTINEL"));
  });
});
