import { describe, expect, it } from "vitest";
import { asSessionId, asToolCallId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/tui-v2/state/transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/tui-v2/state/transcript-types.js";
import { renderTranscriptPlainText } from "../../../src/tui-v2/rendering/transcript-export.js";

function buildState() {
  const seq = new EventSequencer(asSessionId("s1"));
  let state = EMPTY_TRANSCRIPT_STATE;
  state = applyAppEvent(state, seq.build("turn-started", { prompt: "list files" }, undefined));
  state = applyAppEvent(state, seq.build("thinking-delta", { text: "let me check" }, undefined));
  state = applyAppEvent(
    state,
    seq.build("thinking-block", { messageId: seq.ids.message(), content: "let me check" }, undefined),
  );
  state = applyAppEvent(
    state,
    seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.list", argsDisplay: "." }, undefined),
  );
  state = applyAppEvent(
    state,
    seq.build(
      "tool-result",
      { toolCallId: asToolCallId("c1"), ok: true, exitCode: 0, summary: "3 files", artifactPath: "/tmp/out.txt" },
      undefined,
    ),
  );
  state = applyAppEvent(
    state,
    seq.build("assistant-message", { messageId: seq.ids.message(), text: "Found 3 files." }, undefined),
  );
  return state;
}

describe("renderTranscriptPlainText (V2-057)", () => {
  it("renders user/tool/assistant content in order", () => {
    const text = renderTranscriptPlainText(buildState());
    expect(text).toContain("You:\nlist files");
    expect(text).toContain("Tool: fs.list . — done (exit 0)");
    expect(text).toContain("3 files");
    expect(text).toContain("artifact: /tmp/out.txt");
    expect(text).toContain("Assistant:\nFound 3 files.");
    expect(text.indexOf("You:")).toBeLessThan(text.indexOf("Tool:"));
    expect(text.indexOf("Tool:")).toBeLessThan(text.indexOf("Assistant:"));
  });

  it("excludes thinking by default and includes it when requested", () => {
    const state = buildState();
    expect(renderTranscriptPlainText(state)).not.toContain("let me check");
    expect(renderTranscriptPlainText(state, { includeThinking: true })).toContain("let me check");
  });
});
