import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatImage, CompletionRequest, CompletionResult } from "../../src/types.js";
import {
  accumulateOpenAiToolCallDelta,
  clearTextOnlyModels,
  finalizeOpenAiToolCalls,
} from "../../src/llm/tool-protocol.js";

const streamMock = vi.fn();

vi.mock("../../src/llm/router.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      request: CompletionRequest,
      onToken: (t: string) => void,
    ): Promise<CompletionResult> => streamMock(request, onToken),
    completeWithProvider: vi.fn(),
  };
});

vi.mock("../../src/commands/providers.js", () => ({
  ensureProviderConfigured: vi.fn(async () => undefined),
}));

vi.mock("../../src/agent/confirm-port.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/agent/confirm-port.js")
  >("../../src/agent/confirm-port.js");
  const auto = {
    confirmTool: async () => true,
    confirmPlan: async () => true,
    confirmMany: async (items: Array<{ id: string }>) =>
      Object.fromEntries(items.map((i) => [i.id, true])),
  };
  return {
    ...actual,
    stdioConfirmPort: auto,
  };
});

await import("../../src/agent/runner.js");

const turnEnd = (
  id: string,
  reason: string,
): NonNullable<CompletionResult["toolCalls"]>[number] => ({
  id,
  name: "turn.end",
  args: { reason },
});

const isTurnEndCheck = (message: CompletionRequest["messages"][number]): boolean =>
  message.role === "user" && message.content.startsWith("TURN END CHECK:");

const turnEndCheckIndex = (request: CompletionRequest): number =>
  request.messages.findLastIndex(isTurnEndCheck);

const turnEndCheckCount = (request: CompletionRequest): number =>
  request.messages.filter(isTurnEndCheck).length;

const turnEndFence = (reason: string): string =>
  `\`\`\`tool\n${JSON.stringify({ name: "turn.end", args: { reason } })}\n\`\`\``;

describe("native tool loop integration", () => {
  let cwd: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "clai-native-"));
    process.chdir(cwd);
    streamMock.mockReset();
  });

  afterEach(async () => {
    clearTextOnlyModels();
    process.chdir(prevCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("writes a file from native toolCalls without fence text", async () => {
    const target = join(cwd, "hello.ts");
    const body = "export const n = 42;\n";
    let turn = 0;
    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (t: string) => void,
      ): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          // First turn: native fs.write
          expect(request.tools?.length).toBeGreaterThan(0);
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_write",
                name: "fs.write",
                args: { path: target, content: body },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        // Second turn: final answer
        onToken("done");
        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const autoConfirm = {
      confirmTool: async () => true,
      confirmPlan: async () => true,
      confirmMany: async (items: Array<{ id: string }>) =>
        Object.fromEntries(items.map((i) => [i.id, true as const])),
    };
    const answer = await runAgentLoop("write hello.ts with n=42", {
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 5,
      confirm: autoConfirm as never,
    });

    const written = await readFile(target, "utf8");
    expect(written).toBe(body);
    expect(answer).toContain("done");
    // The provider-cached head contains only the long-lived constitution.
    // Per-request authority is a later system-marked suffix after history.
    expect(streamMock).toHaveBeenCalledTimes(2);
    for (const [request] of streamMock.mock.calls as Array<[CompletionRequest]>) {
      const system = request.messages[0]?.content ?? "";
      expect(request.messages[0]?.role).toBe("system");
      expect(system).toContain("# ROLE");
      expect(system).not.toContain("OUTCOME CONTRACT");
      expect(system).not.toContain("TASK STATE");
      expect(system).not.toContain("WORKSPACE STATUS");
      expect(system).not.toContain("write hello.ts with n=42");

      const requestContext = request.messages.find(
        (message, index) =>
          index > 0 &&
          message.role === "system" &&
          message.content.includes("OUTCOME CONTRACT"),
      )?.content ?? "";
      expect(requestContext).toContain("CURRENT MODE: AGENT");
      expect(requestContext).toContain("OUTCOME CONTRACT");
      expect(requestContext).toContain("PLAN PROTOCOL");
      expect(requestContext).toContain("ENGAGEMENT SCOPE");
      expect(requestContext).toContain("latest user task");
      expect(requestContext).not.toContain("write hello.ts with n=42");
      expect(request.messages.some((message) => message.role === "user" && message.content === "write hello.ts with n=42")).toBe(true);
    }
    // No fence protocol required in first model response
    expect(streamMock.mock.calls[0]![0].tools?.length).toBeGreaterThan(0);
  });

  it("closes and reports a malformed native call instead of treating it as empty", async () => {
    await writeFile(join(cwd, "scene.txt"), "ready", "utf8");
    const events: Array<{ type: string; id?: string; text?: string }> = [];
    let turn = 0;

    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          const rawArguments = `{"path":${JSON.stringify(cwd)}`;
          request.onToolCallDelta?.({
            index: 0,
            id: "call_bad_list",
            name: "fs.read",
            argumentsBytes: rawArguments.length,
          });
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            toolCalls: [
              {
                id: "call_bad_list",
                name: "fs.read",
                args: { _parseError: true, _raw: rawArguments },
                rawArguments,
              },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 2) {
          const malformedAssistant = request.messages.find(
            (message) =>
              message.role === "assistant" &&
              message.toolCalls?.some((call) => call.id === "call_bad_list"),
          );
          expect(malformedAssistant).toBeDefined();
          expect(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.toolCallId === "call_bad_list" &&
                /not valid JSON/i.test(message.content),
            ),
          ).toBe(true);
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            toolCalls: [
              {
                id: "call_good_list",
                name: "fs.read",
                args: { path: cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "call_good_list" &&
              message.content.includes("scene.txt"),
          ),
        ).toBe(true);
        return {
          text: "inspection complete",
          provider: "bynara",
          model: "grok-4.5-free",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("inspect this project", {
      provider: "bynara",
      model: "grok-4.5-free",
      maxSteps: 5,
      onEvent: (event) => events.push(event),
    });

    expect(answer).toBe("inspection complete");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(
      events.filter(
        (event) =>
          event.type === "notice" && /empty response/i.test(event.text ?? ""),
      ),
    ).toHaveLength(0);
    const toolCallIds = new Set(
      events
        .filter((event) => event.type === "tool-call")
        .map((event) => event.id),
    );
    const toolResultIds = new Set(
      events
        .filter((event) => event.type === "tool-result")
        .map((event) => event.id),
    );
    expect(toolCallIds.size).toBe(3);
    expect([...toolCallIds].every((id) => id && toolResultIds.has(id))).toBe(true);
  });

  it("executes suffixed search, read and edit calls without retries or CRLF changes", async () => {
    const target = join(cwd, "state.mjs");
    await writeFile(target, "export const retryLimit = 2;\r\nexport const backoffMs = 50;\r\n");
    const events: Array<{ type: string; ok?: boolean; name?: string }> = [];
    let round = 0;
    streamMock.mockImplementation(async (): Promise<CompletionResult> => {
      round += 1;
      const calls = round === 1
        ? [
            { name: "shell_execcommentaryjson", args: { cwd, command: "rg -n -- 'retryLimit' ." } },
            { name: "fs_readanalysisjson", args: { path: target } },
          ]
        : [{ name: "fs_editjson", args: { path: target, oldText: "retryLimit = 2", newText: "retryLimit = 3", expectedReplacements: 1 } }];
      const state = new Map();
      if (round < 3) {
        calls.forEach((call, index) => accumulateOpenAiToolCallDelta(state, {
          index, id: `suffix-${round}-${index}`,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
      }
      return {
        text: round < 3 ? "" : "Updated retryLimit; preserved backoff and CRLF.",
        provider: "openai", model: "gpt-4o-mini",
        toolCalls: round < 3 ? finalizeOpenAiToolCalls(state) : [turnEnd("suffix-end", "completed")],
        finishReason: "tool_calls",
      };
    });
    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await runAgentLoop("Change retryLimit from 2 to 3 in state.mjs; preserve CRLF and backoffMs.", {
      provider: "openai", model: "gpt-4o-mini", maxSteps: 4,
      onEvent: (event) => events.push(event),
    });
    expect(await readFile(target, "utf8"))
      .toBe("export const retryLimit = 3;\r\nexport const backoffMs = 50;\r\n");
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === "tool-call").map((event) => event.name))
      .toEqual(["shell.exec", "fs.read", "fs.edit", "turn.end"]);
    expect(events.filter((event) => event.type === "tool-result"))
      .toHaveLength(4);
    expect(events.some((event) => event.type === "tool-result" && event.ok === false)).toBe(false);
    const requests = streamMock.mock.calls.map(([request]) => request as CompletionRequest);
    for (const request of requests.slice(1)) {
      expect(request.messages[0]).toEqual(requests[0]!.messages[0]);
      expect(request.tools).toEqual(requests[0]!.tools);
    }
  });

  it("closes an abandoned streamed native call and falls back to text tools", async () => {
    await writeFile(join(cwd, "metro.txt"), "ready", "utf8");
    const events: Array<{ type: string; id?: string; name?: string; reason?: string }> = [];
    let turn = 0;

    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          request.onToolCallDelta?.({
            index: 0,
            id: "call_incomplete_list",
            name: "fs.read",
            argumentsBytes: 12,
          });
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            finishReason: "stop",
          };
        }

        if (turn === 2) {
          expect(
            events.filter((event) => event.type === "tool-call"),
          ).toHaveLength(0);
          expect(request.tools).toBeUndefined();
          const text = `\`\`\`tool\n${JSON.stringify({
            name: "fs.read",
            args: { path: cwd },
          })}\n\`\`\``;
          onToken(text);
          return {
            text,
            provider: "bynara",
            model: "grok-4.5-free",
            finishReason: "stop",
          };
        }

        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" && message.content.includes("metro.txt"),
          ),
        ).toBe(true);
        return {
          text: `listed successfully\n\n${turnEndFence("completed")}`,
          provider: "bynara",
          model: "grok-4.5-free",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect this project", {
        provider: "bynara",
        model: "grok-4.5-free",
        maxSteps: 5,
        onEvent: (event) => events.push(event),
      }),
    ).resolves.toBe("listed successfully");

    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(
      events.filter((event) => event.type === "tool-call").map((event) => event.name),
    ).toEqual(["fs.read", "turn.end"]);
    const pending = events.find((event) => event.type === "tool-call-pending");
    expect(pending?.name).toBe("fs.read");
    expect(events.filter((event) => event.type === "tool-blocked")).toEqual([
      expect.objectContaining({ id: pending?.id, name: "fs.read", reason: expect.stringContaining("Nothing ran") }),
    ]);
  });

  it("stops repeating unusable native arguments and falls back to text tools", async () => {
    await writeFile(join(cwd, "metro.txt"), "ready", "utf8");
    let turn = 0;
    const truncated = '{"path":"/Users/x/indian-metro","filter":"a';

    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        turn += 1;
        if (turn <= 2) {
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            toolCalls: [
              {
                id: `call_bad_${turn}`,
                name: "fs.read",
                args: { _parseError: true, _raw: truncated },
                rawArguments: truncated,
              },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 3) {
          expect(request.tools).toBeUndefined();
          const text = `\`\`\`tool\n${JSON.stringify({
            name: "fs.read",
            args: { path: cwd },
          })}\n\`\`\``;
          onToken(text);
          return {
            text,
            provider: "bynara",
            model: "grok-4.5-free",
            finishReason: "stop",
          };
        }

        return {
          text: `listing complete\n\n${turnEndFence("completed")}`,
          provider: "bynara",
          model: "grok-4.5-free",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect this project", {
        provider: "bynara",
        model: "grok-4.5-free",
        maxSteps: 8,
      }),
    ).resolves.toBe("listing complete");

    // Two malformed rounds, then the text protocol takes over — not an
    // unbounded retry cycle on the same unusable call.
    expect(streamMock).toHaveBeenCalledTimes(4);
  });

  it("re-attaches native tools on the next turn after a degraded fallback", async () => {
    await writeFile(join(cwd, "metro.txt"), "ready", "utf8");
    let turn = 0;
    const truncated = '{"path":"/Users/x/indian-metro","filter":"a';

    streamMock.mockImplementation(
      async (
        request: CompletionRequest,
        onToken: (token: string) => void,
      ): Promise<CompletionResult> => {
        turn += 1;
        if (turn <= 2) {
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            toolCalls: [
              {
                id: `call_bad_${turn}`,
                name: "fs.read",
                args: { _parseError: true, _raw: truncated },
                rawArguments: truncated,
              },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 3) {
          expect(request.tools).toBeUndefined();
          const text = `\`\`\`tool\n${JSON.stringify({
            name: "fs.read",
            args: { path: cwd },
          })}\n\`\`\``;
          onToken(text);
          return {
            text,
            provider: "bynara",
            model: "grok-4.5-free",
            finishReason: "stop",
          };
        }

        return {
          text: "turn one complete",
          provider: "bynara",
          model: "grok-4.5-free",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect this project", {
        provider: "bynara",
        model: "grok-4.5-free",
        maxSteps: 8,
      }),
    ).resolves.toBe("turn one complete");

    streamMock.mockReset();
    streamMock.mockImplementation(async (request: CompletionRequest) => {
      expect(request.tools?.length).toBeGreaterThan(0);
      return {
        text: "turn two complete",
        provider: "bynara",
        model: "grok-4.5-free",
        finishReason: "stop",
      };
    });

    await expect(
      runAgentLoop("inspect again", {
        provider: "bynara",
        model: "grok-4.5-free",
        maxSteps: 4,
      }),
    ).resolves.toBe("turn two complete");
  });

  it("preserves parallel tool bodies and session-state ordering for the next model call", async () => {
    const evidencePath = join(cwd, "evidence.txt");
    const appPath = join(cwd, "index.js");
    const body = `BEGIN-${"x".repeat(16_000)}-END`;
    await writeFile(evidencePath, body, "utf8");
    let turn = 0;

    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              { id: "call_list", name: "fs.read", args: { path: cwd } },
              { id: "call_read", name: "fs.read", args: { path: evidencePath } },
              { id: "call_check", name: "shell.exec", args: { command: "command -v node", cwd } },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 2) {
          const groupStart = request.messages.findIndex(
            (message) =>
              message.role === "assistant" && message.toolCalls?.length === 3,
          );
          expect(groupStart).toBeGreaterThanOrEqual(0);
          const toolGroup = request.messages.slice(groupStart + 1, groupStart + 4);
          expect(toolGroup.map((message) => message.role)).toEqual([
            "tool",
            "tool",
            "tool",
          ]);
          expect(toolGroup.map((message) => message.toolCallId)).toEqual([
            "call_list",
            "call_read",
            "call_check",
          ]);
          expect(toolGroup[0]?.content).toContain("evidence.txt");
          expect(toolGroup[1]?.content).toContain(body);
          expect(toolGroup[2]?.content).toMatch(/node/i);
          expect(toolGroup.map((message) => message.content).join("\n")).not.toMatch(
            /No stored body|\[context-note\]/i,
          );
          expect(
            request.messages
              .slice(groupStart + 4)
              .some((message) => message.role === "system"),
          ).toBe(false);

          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_write",
                name: "fs.write",
                args: { path: appPath, content: 'console.log("ok");\n' },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        if (turn === 3) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_verify",
                name: "shell.exec",
                args: { command: "node --check index.js", cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        return {
          text: "done",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("create a tiny JavaScript app after inspecting the project and tools", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 8,
      }),
    ).resolves.toContain("done");
    await expect(readFile(appPath, "utf8")).resolves.toBe('console.log("ok");\n');
    expect(streamMock).toHaveBeenCalledTimes(4);
  });

  it("checks once before ending on action narration, then accepts the model's reply", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [
              { id: "call_list_first", name: "fs.read", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        const text = "Let's check the remaining files.";
        onToken(text);
        if (turn === 2) {
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            finishReason: "stop",
          };
        }
        return {
          text: "",
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const events: Array<{ type: string; text?: string }> = [];
    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("find all files in this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
      onEvent: (event) => events.push(event),
    });

    expect(streamMock).toHaveBeenCalledTimes(3);
    const checkRequest = streamMock.mock.calls[2]![0] as CompletionRequest;
    const checkIndex = turnEndCheckIndex(checkRequest);
    expect(checkIndex).toBeGreaterThan(0);
    expect(checkRequest.messages[checkIndex]).toMatchObject({ role: "user", internal: true });
    expect(checkRequest.messages[checkIndex - 1]).toMatchObject({
      role: "assistant",
      content: "Let's check the remaining files.",
    });
    expect(turnEndCheckCount(checkRequest)).toBe(1);
    expect(answer).toBe("Let's check the remaining files.");
    expect(
      events.filter(
        (event) =>
          event.type === "assistant-message" &&
          event.text === "Let's check the remaining files.",
      ),
    ).toHaveLength(1);
  });

  it("resumes work when the turn end check is answered with a tool call and finishes without another check", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1 || turn === 3) {
          return {
            text: "",
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [
              { id: `call_read_${turn}`, name: "fs.read", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          const text = "Let me check the remaining files.";
          onToken(text);
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            finishReason: "stop",
          };
        }
        const text = "All files listed.";
        onToken(text);
        return {
          text,
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("find all files in this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 6,
    });

    expect(streamMock).toHaveBeenCalledTimes(4);
    const requests = streamMock.mock.calls.map(([request]) => request as CompletionRequest);
    expect(turnEndCheckIndex(requests[2]!)).toBeGreaterThan(0);
    expect(
      requests[3]!.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "call_read_3",
      ),
    ).toBe(true);
    expect(turnEndCheckCount(requests[3]!)).toBe(1);
    expect(answer).toBe("All files listed.");
  });

  it("ends immediately without a turn end check when a question to the user declares needs_user_input", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [
              { id: "call_list_first", name: "fs.read", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        const text = "I'll check the remaining files next — should I include hidden files?";
        onToken(text);
        return {
          text,
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_end", "needs_user_input")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("find all files in this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
    });

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(answer).toContain("should I include hidden files?");
    for (const [request] of streamMock.mock.calls as Array<[CompletionRequest]>) {
      expect(turnEndCheckCount(request)).toBe(0);
    }
  });

  it("ends a tool-free answer that declares answered with exactly one request", async () => {
    streamMock.mockImplementation(
      async (_request: CompletionRequest, onToken: (token: string) => void) => {
        onToken("Alpha is the first letter.");
        return {
          text: "Alpha is the first letter.",
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_end", "answered")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("what is alpha?", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 3,
    });

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(answer).toBe("Alpha is the first letter.");
  });

  it("does not end the turn when turn.end is mixed with a real tool call", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          const text = "Listing the directory.";
          onToken(text);
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [
              { id: "call_list", name: "fs.read", args: { path: cwd } },
              turnEnd("call_early_end", "completed"),
            ],
            finishReason: "tool_calls",
          };
        }
        const text = "Directory listed.";
        onToken(text);
        return {
          text,
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_final_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("list this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
    });

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(answer).toBe("Directory listed.");
    const secondRequest = streamMock.mock.calls[1]![0] as CompletionRequest;
    expect(
      secondRequest.messages.some(
        (message) => message.role === "tool" && message.toolCallId === "call_list",
      ),
    ).toBe(true);
  });

  it("treats turn.end with an invalid reason as a failed call that does not end the turn", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          const text = "All done.";
          onToken(text);
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            toolCalls: [turnEnd("call_bad_end", "finished_early")],
            finishReason: "tool_calls",
          };
        }
        const text = "All done, for real.";
        onToken(text);
        return {
          text,
          provider: "gemini",
          model: "gemini-test",
          toolCalls: [turnEnd("call_good_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const events: Array<{ type: string; id?: string; ok?: boolean }> = [];
    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("say you are done", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
      onEvent: (event) => events.push(event),
    });

    expect(streamMock).toHaveBeenCalledTimes(2);
    const secondRequest = streamMock.mock.calls[1]![0] as CompletionRequest;
    const failedResult = secondRequest.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call_bad_end",
    );
    expect(failedResult).toBeDefined();
    expect(failedResult!.content).toMatch(/reason/i);
    expect(answer).toBe("All done, for real.");
  });

  it("starts every turn undeclared so a later plain-text reply is still checked", async () => {
    let turn = 0;
    streamMock.mockImplementation(
      async (_request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        const text = `reply ${turn}`;
        onToken(text);
        return {
          text,
          provider: "gemini",
          model: "gemini-test",
          ...(turn === 1
            ? { toolCalls: [turnEnd("call_end", "answered")], finishReason: "tool_calls" }
            : { finishReason: "stop" }),
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const options = {
      provider: "gemini" as const,
      model: "gemini-test",
      maxSteps: 3,
    };
    const first = await runAgentLoop("first question", options);
    expect(first).toBe("reply 1");
    expect(streamMock).toHaveBeenCalledTimes(1);

    const second = await runAgentLoop("second question", options);
    expect(streamMock).toHaveBeenCalledTimes(3);
    const checkRequest = streamMock.mock.calls[2]![0] as CompletionRequest;
    expect(turnEndCheckCount(checkRequest)).toBe(1);
    expect(second).toBe("reply 3");
  });

  it("does not append internal outcome diagnostics to a continue response", async () => {
    streamMock.mockImplementation(
      async (): Promise<CompletionResult> => ({
        text: "Here are the remaining results.",
        provider: "gemini",
        model: "gemini-test",
        finishReason: "stop",
      }),
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("continue", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 2,
      history: [
        { role: "user", content: "find the remaining posts" },
        { role: "assistant", content: "I found the blog index." },
      ],
    });

    expect(answer).toBe("Here are the remaining results.");
    expect(answer).not.toMatch(/Status:|Required outcome criteria|Remaining:/);
  });

  it("keeps the provider cache head identical across different top-level requests", async () => {
    streamMock.mockImplementation(
      async (_request: CompletionRequest, onToken: (token: string) => void) => {
        onToken("answered");
        return {
          text: "answered",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "answered")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await runAgentLoop("Explain alpha", {
      provider: "openai",
      model: "gpt-4o-mini",
      mode: "ask",
    });
    await runAgentLoop("Explain beta", {
      provider: "openai",
      model: "gpt-4o-mini",
      mode: "ask",
    });

    const requests = streamMock.mock.calls.map(
      ([request]) => request as CompletionRequest,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages[0]!.content).toBe(
      requests[1]!.messages[0]!.content,
    );
    expect(requests[0]!.messages[0]!.content).not.toContain("Explain alpha");
    expect(requests[1]!.messages[0]!.content).not.toContain("Explain beta");
    expect(
      requests[0]!.messages.some(
        (message, index) => index > 0 && message.content.includes("Explain alpha"),
      ),
    ).toBe(true);
    expect(
      requests[1]!.messages.some(
        (message, index) => index > 0 && message.content.includes("Explain beta"),
      ),
    ).toBe(true);
  });

  it("returns an image.view payload to the model as a protocol-safe user image turn", async () => {
    const screenshot = join(cwd, "screen.png");
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
      "hex",
    );
    await writeFile(screenshot, png);
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          expect(request.tools?.some((tool) => tool.name === "image.view")).toBe(true);
          return {
            text: "",
            provider: "openai",
            model: "gpt-4o-mini",
            toolCalls: [
              {
                id: "call_view",
                name: "image.view",
                args: { path: screenshot },
              },
            ],
            finishReason: "tool_calls",
          };
        }

        const assistantIndex = request.messages.findIndex(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.some((call) => call.id === "call_view"),
        );
        expect(assistantIndex).toBeGreaterThanOrEqual(0);
        expect(request.messages[assistantIndex + 1]).toMatchObject({
          role: "tool",
          toolCallId: "call_view",
          name: "image.view",
        });
        const imageTurn = request.messages.find(
          (message, index) => index > assistantIndex && message.images?.length,
        );
        expect(imageTurn).toMatchObject({ role: "user", internal: true });
        expect(imageTurn?.images?.[0]).toMatchObject({
          mediaType: "image/png",
          path: screenshot,
        });
        expect(Buffer.from(imageTurn!.images![0]!.dataBase64, "base64")).toEqual(png);
        return {
          text: "The rendered pixel is transparent.",
          provider: "openai",
          model: "gpt-4o-mini",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect the screenshot you generated", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toContain("transparent");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("passes exact image bytes, MIME, and mode to the provider", async () => {
    const image: ChatImage = {
      dataBase64: Buffer.from([0, 1, 2, 253, 254, 255]).toString("base64"),
      mediaType: "image/png",
      path: join(cwd, "screen.png"),
    };
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        const user = request.messages.find((message) => message.role === "user");
        expect(user?.images).toEqual([image]);
        expect(Buffer.from(user!.images![0]!.dataBase64, "base64")).toEqual(
          Buffer.from([0, 1, 2, 253, 254, 255]),
        );
        expect(
          request.messages.some(
            (message, index) =>
              index > 0 &&
              message.role === "system" &&
              message.content.includes("CURRENT MODE: ASK"),
          ),
        ).toBe(true);
        return {
          text: "inspected",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );
    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect this image", {
        provider: "openai",
        model: "gpt-4o-mini",
        mode: "ask",
        images: [image],
      }),
    ).resolves.toBe("inspected");
  });

  it("executes DeepSeek DSML text as a real tool call", async () => {
    await writeFile(join(cwd, "visible.txt"), "ok", "utf8");
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          const text = `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.read"><｜DSML｜parameter name="path" string="true">${cwd}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
          onToken(text);
          return {
            text,
            provider: "tokenrouter",
            model: "deepseek/deepseek-v4-flash-0731",
            finishReason: "stop",
          };
        }
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("visible.txt"),
          ),
        ).toBe(true);
        return {
          text: "done",
          provider: "tokenrouter",
          model: "deepseek/deepseek-v4-flash-0731",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("list this project", {
        provider: "tokenrouter",
        model: "deepseek/deepseek-v4-flash-0731",
        maxSteps: 4,
      }),
    ).resolves.toBe("done");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("executes DSML text whose invoke closer the model omitted", async () => {
    const target = join(cwd, "guard.txt");
    await writeFile(target, "before", "utf8");
    let turn = 0;
    let displayed = "";
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void) => {
        turn += 1;
        if (turn === 1) {
          const text =
            `I'm on t6: add the architecture guard.\n\n` +
            `<｜DSML｜tool_calls>\n<｜DSML｜invoke name="fs_write">\n` +
            `<｜DSML｜parameter name="path" string="true">${target}</｜DSML｜parameter>\n` +
            `<｜DSML｜parameter name="content" string="true">after</｜DSML｜parameter>\n` +
            `</｜DSML｜tool_calls>`;
          onToken(text);
          return {
            text,
            provider: "tokenrouter",
            model: "deepseek/deepseek-v4-flash-0731",
            finishReason: "stop",
          };
        }
        displayed = request.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content)
          .join("\n");
        return {
          text: "guard added",
          provider: "tokenrouter",
          model: "deepseek/deepseek-v4-flash-0731",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("add the architecture guard", {
        provider: "tokenrouter",
        model: "deepseek/deepseek-v4-flash-0731",
        maxSteps: 4,
      }),
    ).resolves.toBe("guard added");
    expect(await readFile(target, "utf8")).toBe("after");
    expect(displayed).not.toContain("DSML");
  });

  it("allows repeated test commands after intervening fixes", async () => {
    const target = join(cwd, "test.js");
    const command = "node test.js";
    await writeFile(target, 'console.error("first failure"); process.exit(1);\n', "utf8");
    let turn = 0;

    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1 || turn === 3 || turn === 5) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: `call_test_${turn}`,
                name: "shell.exec",
                args: { command, cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          expect(
            request.messages.some(
              (message) => message.role === "tool" && message.content.includes("first failure"),
            ),
          ).toBe(true);
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_edit_still_failing",
                name: "fs.write",
                args: {
                  path: target,
                  content: 'console.error("second failure"); process.exit(1);\n',
                },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 4) {
          expect(
            request.messages.some(
              (message) => message.role === "tool" && message.content.includes("second failure"),
            ),
          ).toBe(true);
          expect(
            request.messages.some((message) =>
              message.content.includes("previously failed with identical arguments"),
            ),
          ).toBe(false);
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_edit_passing",
                name: "fs.write",
                args: { path: target, content: 'console.log("passed");\n' },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("passed"),
          ),
        ).toBe(true);
        return {
          text: "fixed and verified",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("fix test.js and rerun node test.js until it passes", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 10,
      }),
    ).resolves.toBe("fixed and verified");
    await expect(readFile(target, "utf8")).resolves.toBe('console.log("passed");\n');
    expect(streamMock).toHaveBeenCalledTimes(6);
  });

  it("keeps identical dynamic observations running while their output changes", async () => {
    await writeFile(join(cwd, "first.txt"), "1", "utf8");
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [{ id: "call_dynamic_1", name: "fs.read", args: { path: cwd } }],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          await writeFile(join(cwd, "second.txt"), "2", "utf8");
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [{ id: "call_dynamic_2", name: "fs.read", args: { path: cwd } }],
            finishReason: "tool_calls",
          };
        }
        if (turn === 3) {
          expect(
            request.messages.some(
              (message) => message.role === "tool" && message.content.includes("second.txt"),
            ),
          ).toBe(true);
          await writeFile(join(cwd, "third.txt"), "3", "utf8");
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [{ id: "call_dynamic_3", name: "fs.read", args: { path: cwd } }],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("third.txt"),
          ),
        ).toBe(true);
        return {
          text: "observed every change",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("poll this directory until the files appear", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 6,
      }),
    ).resolves.toBe("observed every change");
    expect(streamMock).toHaveBeenCalledTimes(4);
  });

  it("allows an identical transiently failing command to recover on retry", async () => {
    const counter = join(cwd, "attempt.txt");
    const command = `node -e 'const fs=require("fs");const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,"utf8"):0)+1;fs.writeFileSync(p,String(n));if(n<2){console.error("transient");process.exit(1)}console.log("recovered")'`;
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn <= 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              { id: `call_transient_${turn}`, name: "shell.exec", args: { command, cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("recovered"),
          ),
        ).toBe(true);
        return {
          text: "retry recovered",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("retry the transient command", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toBe("retry recovered");
    await expect(readFile(counter, "utf8")).resolves.toBe("2");
  });

  it("suppresses an exact replay once and returns prior evidence without duplicating history", async () => {
    await writeFile(join(cwd, "once.txt"), "ok", "utf8");
    let turn = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn <= 4) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: `call_list_${turn}`,
                name: "fs.read",
                args: { path: cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        const toolCalls = request.messages.flatMap((message) => message.toolCalls ?? []);
        expect(toolCalls.filter((call) => call.name === "fs.read")).toHaveLength(4);
        const recovery = request.messages.findLast(
          (message) => message.role === "user" && message.internal,
        );
        expect(recovery?.content).toContain("ACTION CYCLE RECOVERY");
        expect(recovery?.content).toContain("original successful tool results remain in context");
        expect(
          request.messages.some(
            (message) => message.role === "tool" && message.content.includes("once.txt"),
          ),
        ).toBe(true);
        return {
          text: "used the existing listing",
          provider: "openai",
          model: "gpt-test",
          toolCalls: [turnEnd("call_end", "completed")],
          finishReason: "tool_calls",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    await expect(
      runAgentLoop("inspect the project once", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 6,
      }),
    ).resolves.toBe("used the existing listing");
    expect(streamMock).toHaveBeenCalledTimes(5);
  });
});
