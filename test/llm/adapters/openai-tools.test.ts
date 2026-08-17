import { describe, expect, it } from "vitest";
import {
  openAiToolBodyFields,
  toOpenAiToolMessages,
  toOpenAiTools,
} from "../../../src/llm/adapters/openai-tools.js";
import { getToolDefinitions } from "../../../src/tools/definitions.js";
import { toOpenAiMessages } from "../../../src/llm/http.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  isToolsUnsupportedError,
} from "../../../src/llm/tool-protocol.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const compatibleReplay = {
  target: {
    provider: "openai",
    model: "test-compatible",
    dialect: "openai-compatible",
  },
} as const;

describe("openai tools adapter", () => {
  it("toOpenAiTools shape", () => {
    const defs = getToolDefinitions({ names: ["fs.write"] });
    const tools = toOpenAiTools(defs);
    expect(tools[0]).toMatchObject({
      type: "function",
      function: { name: "fs_write" },
    });
    expect(tools[0]!.function.parameters.type).toBe("object");
  });

  it("message round-trip: assistant tool_calls + tool results", () => {
    const wire = toOpenAiToolMessages(
      [
        { role: "user", content: "write it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "fs.write",
              args: { path: "a.ts", content: "x" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          name: "fs.write",
          content: "Wrote a.ts",
        },
      ],
      (m) => m.content,
      compatibleReplay,
    );
    expect(wire[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "fs_write" },
        },
      ],
    });
    expect(wire[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "Wrote a.ts",
    });
  });

  it("replays unsigned reasoning as reasoning_content on tool-call turns", () => {
    const wire = toOpenAiToolMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          reasoningBlock: { text: "let me think" },
          toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.ts" } }],
        },
        { role: "tool", toolCallId: "call_1", name: "fs.read", content: "x" },
      ],
      (m) => m.content,
      compatibleReplay,
    );
    expect(wire[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "let me think",
    });
  });

  it("withholds signed reasoning from reasoning_content", () => {
    const wire = toOpenAiToolMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          reasoningBlock: { text: "secret", signature: "sig" },
          toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.ts" } }],
        },
      ],
      (m) => m.content,
      compatibleReplay,
    );
    expect(wire[1]).not.toHaveProperty("reasoning_content");
  });

  it("replays unsigned reasoning on plain assistant turns", () => {
    const wire = toOpenAiToolMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "done",
          reasoningBlock: { text: "reasoning" },
        },
      ],
      (m) => m.content,
      compatibleReplay,
    );
    expect(wire[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "reasoning",
    });
  });

  it("omits reasoning_content when the turn carried no reasoning", () => {
    const wire = toOpenAiToolMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.ts" } }],
        },
      ],
      (m) => m.content,
      compatibleReplay,
    );
    expect(wire[1]).not.toHaveProperty("reasoning_content");
  });

  it("toOpenAiMessages no longer rewrites tool → user", () => {
    const msgs = toOpenAiMessages([
      {
        role: "tool",
        content: "ok",
        toolCallId: "c1",
      },
    ]);
    expect(msgs[0]!.role).toBe("tool");
    expect((msgs[0] as { tool_call_id?: string }).tool_call_id).toBe("c1");
  });

  it("openAiToolBodyFields attaches tools when present", () => {
    const body = openAiToolBodyFields({
      tools: getToolDefinitions({ names: ["fs.read"] }),
      toolChoice: "auto",
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
    // Parallel calls are the upstream default; the field is only sent when it
    // changes behavior, so a strict gateway cannot 400 on it.
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("sends parallel_tool_calls only when explicitly disabled", () => {
    const body = openAiToolBodyFields({
      tools: getToolDefinitions({ names: ["fs.read"] }),
      toolChoice: "auto",
      parallelToolCalls: false,
    });
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("stream fixture reassembly for large content", () => {
    const fixturePath = resolve(
      __dirname,
      "../fixtures/openai-stream-tool-deltas.jsonl",
    );
    const lines = readFileSync(fixturePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const state = new Map();
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      for (const tc of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
        accumulateOpenAiToolCallDelta(state, tc);
      }
    }
    const calls = finalizeOpenAiToolCalls(state);
    expect(calls[0]!.name).toBe("fs.write");
    expect(String(calls[0]!.args.content)).toContain("export const VALUE");
    expect(String(calls[0]!.args.content).length).toBeGreaterThan(1000);
  });
});


describe("isToolsUnsupportedError parameter attribution", () => {
  it("does not downgrade the protocol when a non-tool field is rejected", () => {
    expect(
      isToolsUnsupportedError({
        status: 400,
        message: "request failed",
        body: "Unrecognized request argument supplied: parallel_tool_calls",
      }),
    ).toBe(false);
    expect(
      isToolsUnsupportedError({
        status: 400,
        message: "request failed",
        body: "Unrecognized request argument supplied: reasoning",
      }),
    ).toBe(false);
  });

  it("still downgrades when tools itself is the offending parameter", () => {
    expect(
      isToolsUnsupportedError({
        status: 400,
        message: "request failed",
        body: "Unrecognized request argument supplied: tools",
      }),
    ).toBe(true);
  });
});
