import { describe, expect, it } from "vitest";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  MAX_TOOL_ARG_BYTES,
  parseToolArguments,
  repairConcatenatedToolArguments,
} from "../src/llm/tool-protocol.js";

/**
 * Bynara/Grok streams the FULL arguments object in every tool-call delta.
 * Concatenating them produced `{"path":"x"}{"path":"x"}`, which no longer
 * parsed, so the tool never ran and the model retried the same call forever.
 */
describe("duplicated full-snapshot tool arguments", () => {
  it("keeps one copy when every delta resends the whole arguments object", () => {
    const state = new Map();
    const snapshot = '{"path":"/Users/aniketpandey/Desktop/indian-metro"}';
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call-1",
      function: { name: "fs_list", arguments: snapshot },
    });
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { arguments: snapshot },
    });

    const [call] = finalizeOpenAiToolCalls(state);
    expect(call!.name).toBe("fs.list");
    expect(call!.args).toEqual({
      path: "/Users/aniketpandey/Desktop/indian-metro",
    });
    expect(call!.args._parseError).toBeUndefined();
  });

  it("still accumulates genuine incremental fragments", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call-2",
      function: { name: "fs_read", arguments: '{"path":' },
    });
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { arguments: '"/tmp/a.ts"}' },
    });

    const [call] = finalizeOpenAiToolCalls(state);
    expect(call!.args).toEqual({ path: "/tmp/a.ts" });
  });

  it("accepts arguments emitted as a JSON object instead of a string", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call-3",
      function: { name: "fs_read", arguments: { path: "/tmp/kimi.ts" } },
    });

    const [call] = finalizeOpenAiToolCalls(state);
    expect(call!.name).toBe("fs.read");
    expect(call!.args).toEqual({ path: "/tmp/kimi.ts" });
    expect(call!.args._parseError).toBeUndefined();
  });

  it("rejects an object-form argument payload over the shared size limit", () => {
    const state = new Map();
    expect(() =>
      accumulateOpenAiToolCallDelta(state, {
        index: 0,
        function: {
          arguments: { content: "x".repeat(MAX_TOOL_ARG_BYTES) },
        },
      }),
    ).toThrow(`Tool call arguments exceeded ${MAX_TOOL_ARG_BYTES} bytes`);
  });

  it("repairs already-concatenated argument objects", () => {
    expect(parseToolArguments('{"path":"/tmp/x"}{"path":"/tmp/x"}')).toEqual({
      path: "/tmp/x",
    });
    expect(parseToolArguments("{}{}")).toEqual({});
    expect(repairConcatenatedToolArguments('{"a":1}{"b":2}')).toEqual({
      a: 1,
      b: 2,
    });
  });

  it("still flags genuinely truncated arguments so write salvage can run", () => {
    const args = parseToolArguments('{"path":"/tmp/a.ts","content":"half');
    expect(args._parseError).toBe(true);
    expect(
      repairConcatenatedToolArguments('{"path":"/tmp/a.ts"} trailing'),
    ).toBeUndefined();
  });
});
