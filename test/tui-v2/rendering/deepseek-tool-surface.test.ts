import { describe, expect, it } from "vitest";
import {
  isToolFenceOnlyText,
  stripToolCallSurfaces,
} from "../../../src/ui-core/rendering/strip-tool-surfaces.js";
import {
  EMPTY_STRIP_STREAM,
  pushStripChunk,
  type StripStream,
} from "../../../src/ui-core/rendering/incremental-strip.js";
import {
  parseAllToolCalls,
  parseToolCall,
  stripSentinelTokens,
  textBeforeToolCall,
} from "../../../src/agent/tool-call-parser.js";

const PROSE = "Let me read that file.\n\n";

const DEEPSEEK_CALL =
  '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>fs.read\n```json\n{"path":"src/a.ts"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';

function streamFrames(text: string): string[] {
  let stream: StripStream = EMPTY_STRIP_STREAM;
  const frames: string[] = [];
  for (const ch of text) {
    const pushed = pushStripChunk(stream, ch);
    stream = pushed.stream;
    frames.push(pushed.text);
  }
  return frames;
}

function residueBeyondProse(text: string): string[] {
  return streamFrames(text)
    .map((frame) => frame.slice(PROSE.length))
    .filter((residue) => residue.trim().length > 0);
}

describe("deepseek tool-call surfaces", () => {
  it("strips a complete deepseek tool block from display text", () => {
    expect(stripToolCallSurfaces(PROSE + DEEPSEEK_CALL).trim()).toBe(
      PROSE.trim(),
    );
  });

  it("strips a truncated deepseek tool block", () => {
    const truncated =
      PROSE + '<｜tool▁call▁begin｜>function<｜tool▁sep｜>fs.read\n```json\n{"pa';
    expect(stripToolCallSurfaces(truncated).trim()).toBe(PROSE.trim());
  });

  it("accepts the ascii underscore spelling of the same markers", () => {
    const ascii =
      PROSE +
      '<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>fs.read\n```json\n{"path":"a"}\n```<|tool_call_end|><|tool_calls_end|>';
    expect(stripToolCallSurfaces(ascii).trim()).toBe(PROSE.trim());
  });

  it("treats a deepseek-only message as tool-fence-only", () => {
    expect(isToolFenceOnlyText(DEEPSEEK_CALL)).toBe(true);
  });

  it("never paints any part of the markers while they stream", () => {
    expect(residueBeyondProse(PROSE + DEEPSEEK_CALL)).toEqual([]);
  });

  it("never paints a partial tool fence opener while it streams", () => {
    expect(
      residueBeyondProse(
        `${PROSE}\`\`\`tool\n{"name":"fs.read","args":{"path":"a"}}\n\`\`\``,
      ),
    ).toEqual([]);
  });

  it("still shows an ordinary code fence once its opener line completes", () => {
    const frames = streamFrames("Here:\n```ts\nconst a = 1;\n");
    expect(frames[frames.length - 1]).toContain("```ts");
    expect(frames[frames.length - 1]).toContain("const a = 1;");
  });

  it("parses a deepseek tool call instead of silently dropping it", () => {
    const call = parseToolCall(PROSE + DEEPSEEK_CALL);
    expect(call).toMatchObject({ name: "fs.read", args: { path: "src/a.ts" } });
  });

  it("parses every deepseek call in a multi-call block", () => {
    const two =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>fs.read\n```json\n{"path":"a"}\n```<｜tool▁call▁end｜>' +
      '<｜tool▁call▁begin｜>function<｜tool▁sep｜>fs.read\n```json\n{"path":"b"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    expect(parseAllToolCalls(two).map((call) => call.args)).toEqual([
      { path: "a" },
      { path: "b" },
    ]);
  });

  it("keeps the deepseek block out of the displayed answer text", () => {
    expect(textBeforeToolCall(PROSE + DEEPSEEK_CALL)).toBe(PROSE.trim());
    expect(stripSentinelTokens(PROSE + DEEPSEEK_CALL)).toBe(PROSE.trim());
  });

  it("does not mistake prose mentioning the marker names for a tool call", () => {
    const prose = "The tool_sep convention is unrelated to any call here.";
    expect(parseToolCall(prose)).toBeUndefined();
    expect(stripToolCallSurfaces(prose)).toBe(prose);
  });
});
