import { describe, expect, it } from "vitest";
import {
  accumulateOpenAiToolCallDelta,
  clearDegradedToolModels,
  clearTextOnlyModels,
  finalizeOpenAiToolCalls,
  fromWireName,
  isToolsUnsupportedError,
  markDegradedToolModel,
  markTextOnlyModel,
  isTextOnlyModel,
  parseToolArguments,
  registerWireNamesFor,
  syntheticToolCallId,
  toSnakeWireName,
  toWireName,
} from "../../src/llm/tool-protocol.js";
import { ProviderError } from "../../src/llm/http.js";
// Ensure full tool wire map (snake aliases) is registered.
import "../../src/tools/definitions.js";

describe("tool-protocol helpers", () => {
  it("maps dotted names to wire names (camel primary)", () => {
    expect(toWireName("fs.write")).toBe("fs_write");
    expect(toWireName("shell.exec")).toBe("shell_exec");
    expect(toWireName("fs.writeMany")).toBe("fs_writeMany");
    expect(toSnakeWireName("fs.writeMany")).toBe("fs_write_many");
    expect(toSnakeWireName("fs.replaceLines")).toBe("fs_replace_lines");
    expect(toSnakeWireName("net.pingSweep")).toBe("net_ping_sweep");
  });

  it("reverse-maps both camel and pure-snake wire forms", () => {
    registerWireNamesFor("fs.writeMany");
    registerWireNamesFor("fs.replaceLines");
    registerWireNamesFor("net.pingSweep");
    expect(fromWireName("fs_writeMany")).toBe("fs.writeMany");
    expect(fromWireName("fs_write_many")).toBe("fs.writeMany");
    expect(fromWireName("fs_replaceLines")).toBe("fs.replaceLines");
    expect(fromWireName("fs_replace_lines")).toBe("fs.replaceLines");
    expect(fromWireName("net_pingSweep")).toBe("net.pingSweep");
    expect(fromWireName("net_ping_sweep")).toBe("net.pingSweep");
  });

  it("parses object and string arguments; flags invalid JSON", () => {
    expect(parseToolArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolArguments('{"path":"x"}')).toEqual({ path: "x" });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("{broken")._parseError).toBe(true);
  });

  it("recovers malformed native arguments leniently instead of failing the call", () => {
    expect(parseToolArguments('{"command":"echo line1\nline2"}')).toEqual({
      command: "echo line1\nline2",
    });
    expect(parseToolArguments("{“command”:“echo hi”}")).toEqual({
      command: "echo hi",
    });
    expect(parseToolArguments("{'command':'echo hi'}")).toEqual({
      command: "echo hi",
    });
    expect(parseToolArguments('{"command":"echo hi",}')).toEqual({
      command: "echo hi",
    });
    expect(
      parseToolArguments('{"path":"/tmp/a.ts","content":"half')._parseError,
    ).toBe(true);
  });

  it("degrades a model to text tools for the rest of the turn only", () => {
    clearTextOnlyModels();
    markDegradedToolModel("agentrouter", "deepseek-v4");
    expect(isTextOnlyModel("agentrouter", "deepseek-v4")).toBe(true);
    clearDegradedToolModels();
    expect(isTextOnlyModel("agentrouter", "deepseek-v4")).toBe(false);
    markTextOnlyModel("agentrouter", "deepseek-v4");
    clearDegradedToolModels();
    expect(isTextOnlyModel("agentrouter", "deepseek-v4")).toBe(true);
    clearTextOnlyModels();
    expect(isTextOnlyModel("agentrouter", "deepseek-v4")).toBe(false);
  });

  it("reassembles streaming tool_call argument deltas", () => {
    const state = new Map();
    const first = accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "call_1",
      function: { name: "fs_write", arguments: '{"path":"a.ts","content":"' },
    });
    expect(first.nameBecameKnown).toBe(true);
    expect(first.name).toBe("fs_write");
    const second = accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { arguments: 'hello\\nworld"}' },
    });
    expect(second.nameBecameKnown).toBe(false);
    expect(second.argumentsBytes).toBeGreaterThan(first.argumentsBytes);
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("fs.write");
    expect(calls[0]!.args).toEqual({ path: "a.ts", content: "hello\nworld" });
    expect(calls[0]!.id).toBe("call_1");
  });

  it("reports nameBecameKnown only on first name delta (P2-3)", () => {
    const state = new Map();
    const a = accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { name: "web_search", arguments: "{" },
    });
    const b = accumulateOpenAiToolCallDelta(state, {
      index: 0,
      function: { arguments: '"q":"x"}' },
    });
    expect(a.nameBecameKnown).toBe(true);
    expect(b.nameBecameKnown).toBe(false);
    expect(b.name).toBe("web_search");
  });

  it("handles parallel tool call indices", () => {
    const state = new Map();
    accumulateOpenAiToolCallDelta(state, {
      index: 0,
      id: "a",
      function: { name: "fs_read", arguments: '{"path":"a"}' },
    });
    accumulateOpenAiToolCallDelta(state, {
      index: 1,
      id: "b",
      function: { name: "fs_list", arguments: "{}" },
    });
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls.map((c) => c.name)).toEqual(["fs.read", "fs.list"]);
  });

  it("detects tools-unsupported errors (true only for clear capability reject)", () => {
    expect(
      isToolsUnsupportedError(
        new ProviderError("tools is not supported", 400, "tools is not supported"),
      ),
    ).toBe(true);
    expect(
      isToolsUnsupportedError(
        new ProviderError(
          "this model does not support tools",
          400,
          "this model does not support tools",
        ),
      ),
    ).toBe(true);
    expect(
      isToolsUnsupportedError(
        new ProviderError(
          "function calling is not enabled",
          400,
          "function calling is not enabled for this model",
        ),
      ),
    ).toBe(true);
    // Schema / validation failures must NOT sticky-disable tools.
    expect(
      isToolsUnsupportedError(
        new ProviderError(
          "Invalid schema for function 'fs_write'",
          400,
          "Invalid schema for function 'fs_write'",
        ),
      ),
    ).toBe(false);
    expect(
      isToolsUnsupportedError(
        new ProviderError(
          "tools: missing required parameter",
          400,
          "Invalid request: tools validation failed",
        ),
      ),
    ).toBe(false);
    expect(isToolsUnsupportedError(new Error("network down"))).toBe(false);
  });

  it("tracks sticky text-only models", () => {
    clearTextOnlyModels();
    markTextOnlyModel("ollama", "tiny");
    expect(isTextOnlyModel("ollama", "tiny")).toBe(true);
    clearTextOnlyModels();
    expect(isTextOnlyModel("ollama", "tiny")).toBe(false);
  });

  it("synthetic ids remain unique within the same millisecond", () => {
    const first = syntheticToolCallId(0);
    const second = syntheticToolCallId(0);
    expect(first).toMatch(/^call_0_/);
    expect(second).toMatch(/^call_0_/);
    expect(second).not.toBe(first);
  });
});
