import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatImage, CompletionRequest, CompletionResult } from "../../src/types.js";
import { clearTextOnlyModels } from "../../src/llm/tool-protocol.js";

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
          finishReason: "stop",
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
      expect(requestContext).toContain("TASK STATE");
      expect(requestContext).toContain("write hello.ts with n=42");
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
            name: "fs.list",
            argumentsBytes: rawArguments.length,
          });
          return {
            text: "",
            provider: "bynara",
            model: "grok-4.5-free",
            toolCalls: [
              {
                id: "call_bad_list",
                name: "fs.list",
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
                name: "fs.list",
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
          finishReason: "stop",
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
    expect(toolCallIds.size).toBe(2);
    expect([...toolCallIds].every((id) => id && toolResultIds.has(id))).toBe(true);
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
            name: "fs.list",
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
            name: "fs.list",
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
          text: "listed successfully",
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
      events.filter((event) => event.type === "tool-call"),
    ).toHaveLength(1);
    expect(
      events.some((event) => event.type === "tool-blocked"),
    ).toBe(false);
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
                name: "fs.list",
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
            name: "fs.list",
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
          text: "listing complete",
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
              { id: "call_list", name: "fs.list", args: { path: cwd } },
              { id: "call_read", name: "fs.read", args: { path: evidencePath } },
              { id: "call_check", name: "tool.check", args: { tools: ["node"] } },
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
          expect(request.messages[groupStart + 4]).toMatchObject({
            role: "system",
          });

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
          finishReason: "stop",
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

  it("recovers when action narration follows a productive tool step", async () => {
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
              { id: "call_list_first", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          const text = "Let's check the remaining files.";
          onToken(text);
          return {
            text,
            provider: "gemini",
            model: "gemini-test",
            finishReason: "stop",
          };
        }
        expect(request.messages.at(-1)?.content).toMatch(/call.*tool|take the action/i);
        return {
          text: "Found all remaining files.",
          provider: "gemini",
          model: "gemini-test",
          finishReason: "stop",
        };
      },
    );

    const { runAgentLoop } = await import("../../src/agent/runner.js");
    const answer = await runAgentLoop("find all files in this directory", {
      provider: "gemini",
      model: "gemini-test",
      maxSteps: 5,
    });

    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(answer).toBe("Found all remaining files.");
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
          finishReason: "stop",
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
          finishReason: "stop",
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
          const text = `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.list"><｜DSML｜parameter name="path" string="true">${cwd}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
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
          finishReason: "stop",
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
          finishReason: "stop",
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
            toolCalls: [{ id: "call_dynamic_1", name: "fs.list", args: { path: cwd } }],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          await writeFile(join(cwd, "second.txt"), "2", "utf8");
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [{ id: "call_dynamic_2", name: "fs.list", args: { path: cwd } }],
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
            toolCalls: [{ id: "call_dynamic_3", name: "fs.list", args: { path: cwd } }],
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
          finishReason: "stop",
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
                name: "fs.list",
                args: { path: cwd },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        const toolCalls = request.messages.flatMap((message) => message.toolCalls ?? []);
        expect(toolCalls.filter((call) => call.name === "fs.list")).toHaveLength(4);
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
          finishReason: "stop",
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
