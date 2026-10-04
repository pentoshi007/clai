import { describe, expect, it } from "vitest";
import {
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
  toAnthropicTools,
} from "../../../src/llm/adapters/anthropic-tools.js";
import { getToolDefinitions } from "../../../src/tools/definitions.js";

describe("anthropic tools adapter", () => {
  it("maps tools to input_schema", () => {
    const tools = toAnthropicTools(getToolDefinitions({ names: ["fs.write"] }));
    expect(tools[0]).toMatchObject({
      name: "fs_write",
      input_schema: { type: "object" },
    });
  });

  it("converts tool_use + tool_result history", () => {
    const msgs = toAnthropicToolMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "ok",
        toolCalls: [
          { id: "toolu_1", name: "fs.write", args: { path: "a", content: "b" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "toolu_1",
        content: "Wrote a",
        ok: true,
      },
    ]);
    expect(msgs[1]!.role).toBe("assistant");
    const blocks = msgs[1]!.content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
    expect(msgs[2]!.role).toBe("user");
    const results = msgs[2]!.content as Array<{
      type: string;
      is_error?: boolean;
    }>;
    expect(results[0]!.type).toBe("tool_result");
    expect(results[0]!.is_error).toBe(false);
  });

  it("sets tool_result is_error from ok flag and content prefix", () => {
    const byFlag = toAnthropicToolMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "fs.read", args: { path: "x" } }],
      },
      {
        role: "tool",
        toolCallId: "t1",
        content: "Tool fs.read result (exit=1, ok=false):\nmissing",
        ok: false,
      },
    ]);
    const flagResults = byFlag[1]!.content as Array<{
      type: string;
      is_error?: boolean;
    }>;
    expect(flagResults[0]!.is_error).toBe(true);

    const byPrefix = toAnthropicToolMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t2", name: "fs.read", args: { path: "x" } }],
      },
      {
        role: "tool",
        toolCallId: "t2",
        content: "Tool fs.read result (exit=1, ok=false):\nmissing",
      },
    ]);
    const prefixResults = byPrefix[1]!.content as Array<{
      type: string;
      is_error?: boolean;
    }>;
    expect(prefixResults[0]!.is_error).toBe(true);
  });

  it("parses tool_use response blocks", () => {
    const parsed = parseAnthropicToolUseBlocks([
      { type: "text", text: "writing" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "fs_write",
        input: { path: "a.ts", content: "x" },
      },
    ]);
    expect(parsed.text).toBe("writing");
    expect(parsed.toolCalls[0]!.name).toBe("fs.write");
    expect(parsed.toolCalls[0]!.args).toEqual({ path: "a.ts", content: "x" });
  });

  it("accumulates input_json_delta", () => {
    const state = createAnthropicToolStreamState();
    handleAnthropicStreamEvent(state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "fs_write" },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: '{"path":"a","content":"',
      },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'hello"}' },
    });
    const fin = finalizeAnthropicToolStream(state);
    expect(fin.toolCalls[0]!.args).toEqual({ path: "a", content: "hello" });
  });

  it("supports multiple tool_use in one assistant message", () => {
    const parsed = parseAnthropicToolUseBlocks([
      {
        type: "tool_use",
        id: "1",
        name: "fs_read",
        input: { path: "a" },
      },
      {
        type: "tool_use",
        id: "2",
        name: "fs_read",
        input: {},
      },
    ]);
    expect(parsed.toolCalls).toHaveLength(2);
  });
});
