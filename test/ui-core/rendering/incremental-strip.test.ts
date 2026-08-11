import { describe, expect, it } from "vitest";
import {
  EMPTY_STRIP_STREAM,
  pushStripChunk,
  type StripStream,
} from "../../../src/ui-core/rendering/incremental-strip.js";
import { stripToolCallSurfaces } from "../../../src/ui-core/rendering/strip-tool-surfaces.js";
import { asSessionId, asToolCallId, asTurnId } from "../../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../../src/app/events/sequencer.js";
import { applyAppEvent } from "../../../src/ui-core/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type AssistantItem,
} from "../../../src/ui-core/state/transcript-types.js";

function streamAll(chunks: readonly string[]): { text: string; stream: StripStream } {
  let stream = EMPTY_STRIP_STREAM;
  let text = "";
  for (const chunk of chunks) {
    const pushed = pushStripChunk(stream, chunk);
    stream = pushed.stream;
    text = pushed.text;
  }
  return { text, stream };
}

function chunk(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

function buildSequencer() {
  return new EventSequencer(asSessionId("sess-strip"), createCountingIdFactory("s-"), {
    now: () => 1_700_000_000_000,
  });
}

describe("incremental tool-surface stripping (TUI-003)", () => {
  it("matches a one-shot strip for prose, fences and xml tool surfaces", () => {
    const cases = [
      "Plain prose across\nseveral lines.\n\nAnd a paragraph.",
      "before\n```tool\n{\"name\":\"fs.read\"}\n```\nafter",
      "text <tool_call name=\"x\">{\"a\":1}</tool_call> tail",
      "before\n<|tool_calls_section_begin|><|tool_call_begin|>functions.sysinfo:1<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>\nafter",
      `before\n<｜DSML｜tool_calls><｜DSML｜invoke name="fs.list"><｜DSML｜parameter name="path" string="true">/tmp</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>\nafter`,
      `before\n<|open|>tools<|sep|><|open|>call tool="fs.read" index="1"<|sep|><|open|>argument key="path" type="string"<|sep|>/tmp/a<|close|>argument><|close|>call><|close|>tools>\nafter`,
      `before\n<tool_calls:abc><tool_call:abc>web.search\n{"query":"term"}\n</tool_call:abc></tool_calls:abc>\nafter`,
      "leading\n\n\n\nblank runs collapse",
      `${"paragraph line\n".repeat(900)}\n\`\`\`tool\n{"name":"fs.write"}\n\`\`\`\ndone`,
    ];
    for (const source of cases) {
      for (const size of [1, 7, 512]) {
        expect(streamAll(chunk(source, size)).text).toBe(stripToolCallSurfaces(source));
      }
    }
  });

  it("never exposes fragmented pseudo-tool markers while streaming", () => {
    const cases = [
      `before\n<|tool_calls_section_begin|><|tool_call_begin|>functions.sysinfo:1<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>\nafter`,
      `before\n<｜DSML｜tool_calls><｜DSML｜invoke name="fs.list"><｜DSML｜parameter name="path" string="true">/tmp</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>\nafter`,
      `before\n<|open|>tools<|sep|><|open|>call tool="fs.read"<|sep|><|open|>argument key="path" type="string"<|sep|>/tmp/a<|close|>argument><|close|>call><|close|>tools>\nafter`,
      `before\n<tool_calls:abc><tool_call:abc>web.search\n{"query":"term"}\n</tool_call:abc></tool_calls:abc>\nafter`,
    ];
    for (const source of cases) {
      const expected = stripToolCallSurfaces(source);
      let stream = EMPTY_STRIP_STREAM;
      for (const character of source) {
        const pushed = pushStripChunk(stream, character);
        stream = pushed.stream;
        expect(expected.startsWith(pushed.text)).toBe(true);
      }
    }
  });

  it("keeps the rescanned tail bounded as the message grows", () => {
    const small = streamAll(chunk("word ".repeat(2_000), 64)).stream;
    const large = streamAll(chunk("word ".repeat(64_000), 64)).stream;
    expect(large.rawTail.length).toBeLessThanOrEqual(small.rawTail.length + 4_096);
    expect(large.rawTail.length).toBeLessThan(8_192);
    expect(large.stableText.length).toBeGreaterThan(200_000);
  });

  it("returns to the cheap append path after a fence closes", () => {
    const prose = "word ".repeat(2_000);
    const source = `answer\n\`\`\`tool\n{"name":"fs.read"}\n\`\`\`\n${prose}`;
    const { text, stream } = streamAll(chunk(source, 64));
    expect(text).toBe(stripToolCallSurfaces(source));
    expect(stream.clean).toBe(true);
    expect(stream.rawTail.length).toBeLessThan(8_192);
  });

  it("holds an open fence in the tail until it closes", () => {
    let stream = EMPTY_STRIP_STREAM;
    let pushed = pushStripChunk(stream, "answer\n```tool\n{\"name\":\"fs.");
    expect(pushed.text).toBe("answer\n");
    stream = pushed.stream;
    pushed = pushStripChunk(stream, "read\"}\n```\nall set");
    expect(pushed.text).toBe("answer\n\nall set");
  });

  it("streams a long assistant reply through the reducer without quadratic rework", () => {
    const seq = buildSequencer();
    const turnId = asTurnId("turn-1");
    let state = EMPTY_TRANSCRIPT_STATE;
    const body = "sentence about the change. ".repeat(4_000);
    for (const part of chunk(body, 40)) {
      state = applyAppEvent(state, seq.build("assistant-delta", { text: part }, turnId));
    }
    const item = transcriptItems(state)[0] as AssistantItem;
    expect(item.text).toBe(stripToolCallSurfaces(body));
    const stream = state.assistantStripStreams.get(state.pendingAssistantId!)!;
    expect(stream.rawTail.length).toBeLessThan(8_192);

    state = applyAppEvent(
      state,
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a" }, turnId),
    );
    expect(state.assistantStripStreams.size).toBe(1);
    state = applyAppEvent(
      state,
      seq.build("tool-started", { toolCallId: asToolCallId("c1") }, turnId),
    );
    expect(state.assistantStripStreams.size).toBe(0);
  });
});
