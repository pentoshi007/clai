import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import {
  parseAllToolCalls,
  parseToolCall,
  looksLikeTruncatedToolCall,
  textBeforeToolCall,
  stripSentinelTokens,
} from "../../src/agent/tool-call-parser.js";
import { stripToolCallSurfaces } from "../../src/ui-core/rendering/strip-tool-surfaces.js";
import { repairToolProtocol } from "../../src/agent/tool-history.js";

const IMAGE1_SNIPPET =
  "I'm at t4. I'll send a small non-streaming Responses request directly to opencode.ai in a controlled header matrix: bare, current-local shape, release shape, and release shape with individual identity headers removed. Each request is capped at 8 output tokens and only status plus a short response prefix is retained. to=shell.exec code: {\"command\":\"set -u\\nmkdir -p /tmp/oc-test\",\"timeoutMs\":240000}Running the matrix now.\n\nto=functions.shell_exec code:\n{\"command\":\"echo hello\"}";

const IMAGE2_SNIPPET =
  "to=functions.shell_exec code:\n{\"command\":\"echo ok\"}";

const IMAGE3_SNIPPET =
  "The delta is now bounded by evidence:\n• Same endpoint, model, Bearer public, content type, client label, and Responses API.\n\nI'll mark the diff task complete and isolate the causal header set with controlled direct requests.{\"name\":\"task.update\",\"args\":{\"taskId\":\"t3\",\"state\":\"done\",\"note\":\"Compared mitm captures.\"}} to=functions.task_update code:\n{\"taskId\":\"t3\",\"state\":\"done\",\"note\":\"Compared mitm captures.\"}\nto=shell.exec code:\n{\"command\":\"echo ok\"} to=functions.shell_exec code:\n{\"command\":\"echo ok\"}\nto=functions.shell_exec code:\n{\"command\":\"echo ok\"}";

describe("to=... code: tool call parsing", () => {
  it("parses single to=functions.shell_exec code: format", () => {
    const call = parseToolCall(IMAGE2_SNIPPET);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({ command: "echo ok" });
  });

  it("parses calls from Image 1 snippet with multiple calls and interleaved prose", () => {
    const calls = parseAllToolCalls(IMAGE1_SNIPPET);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.name).toBe("shell.exec");
    expect(calls[0]!.args.command).toContain("set -u");
    expect(calls[0]!.args.timeoutMs).toBe(240000);
    expect(calls[1]!.name).toBe("shell.exec");
    expect(calls[1]!.args).toEqual({ command: "echo hello" });
  });

  it("parses and deduplicates calls from Image 3 snippet", () => {
    const calls = parseAllToolCalls(IMAGE3_SNIPPET);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.name).toBe("task.update");
    expect(calls[0]!.args.taskId).toBe("t3");
    expect(calls[1]!.name).toBe("shell.exec");
    expect(calls[1]!.args).toEqual({ command: "echo ok" });
  });

  it("handles case and quote variations", () => {
    const c1 = parseToolCall('to="functions.fs_list" code:\n{"path":"src"}');
    expect(c1?.name).toBe("fs.list");
    expect(c1?.args).toEqual({ path: "src" });

    const c2 = parseToolCall('TO=task.update CODE: {"taskId":"t1"}');
    expect(c2?.name).toBe("task.update");
    expect(c2?.args).toEqual({ taskId: "t1" });
  });
});

describe("to=... code: surface stripping", () => {
  it("strips to=... code: blocks from Image 1 snippet leaving clean prose", () => {
    const stripped = stripToolCallSurfaces(IMAGE1_SNIPPET);
    expect(stripped).toContain("I'm at t4.");
    expect(stripped).toContain("Running the matrix now.");
    expect(stripped).not.toContain("to=shell.exec");
    expect(stripped).not.toContain("to=functions.shell_exec");
    expect(stripped).not.toContain("echo hello");
  });

  it("strips Image 2 call to empty string", () => {
    expect(stripToolCallSurfaces(IMAGE2_SNIPPET).trim()).toBe("");
  });

  it("strips Image 3 leaked tool surfaces leaving only prose", () => {
    const stripped = stripToolCallSurfaces(IMAGE3_SNIPPET);
    expect(stripped).toContain("The delta is now bounded by evidence:");
    expect(stripped).toContain("I'll mark the diff task complete");
    expect(stripped).not.toContain("to=functions.task_update");
    expect(stripped).not.toContain("to=shell.exec");
    expect(stripped).not.toContain("echo ok");
  });

  it("textBeforeToolCall cuts before to=... code:", () => {
    expect(textBeforeToolCall(IMAGE1_SNIPPET)).toContain("I'm at t4.");
    expect(textBeforeToolCall(IMAGE1_SNIPPET)).not.toContain("to=shell.exec");
    expect(textBeforeToolCall(IMAGE2_SNIPPET)).toBe("");
  });

  it("stripSentinelTokens removes to=... code: blocks", () => {
    const stripped = stripSentinelTokens(IMAGE1_SNIPPET);
    expect(stripped).toContain("Running the matrix now.");
    expect(stripped).not.toContain("to=shell.exec");
    expect(stripped).not.toContain("to=functions.shell_exec");
  });

  it("detects in-flight truncation during streaming", () => {
    const partial = "Analyzing.\n\nto=functions.shell_exec code:\n{\"command\":\"ls";
    expect(looksLikeTruncatedToolCall(partial)).toBe(true);
  });
});

describe("history healing for contaminated sessions", () => {
  it("cleans contaminated assistant messages with native tool calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "to=functions.shell_exec code:\n{\"command\":\"echo ok\"}",
        toolCalls: [
          {
            id: "call_1",
            name: "shell.exec",
            args: { command: "echo ok" },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "ok" },
    ];

    const repairs = repairToolProtocol(messages);
    expect(repairs).toBeGreaterThan(0);
    expect(messages[0]!.content).toBe("");
  });

  it("cleans trailing unparsed to=... code: from assistant text messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: IMAGE3_SNIPPET,
      },
    ];

    const repairs = repairToolProtocol(messages);
    expect(repairs).toBeGreaterThan(0);
    expect(messages[0]!.content).toContain("The delta is now bounded by evidence:");
    expect(messages[0]!.content).not.toContain("to=functions.task_update");
    expect(messages[0]!.content).not.toContain("echo ok");
  });
});
