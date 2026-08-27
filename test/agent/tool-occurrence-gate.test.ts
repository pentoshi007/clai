import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import { runAgentLoop } from "../../src/agent/runner.js";
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

describe("tool occurrence execution gate (T620)", () => {
  let cwd: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "clai-occurrence-"));
    process.chdir(cwd);
    streamMock.mockReset();
  });

  afterEach(async () => {
    clearTextOnlyModels();
    process.chdir(prevCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  it("does not re-execute a provider call id replayed in a later round", async () => {
    const counter = join(cwd, "append-counter.txt");
    const command = `node -e 'const fs=require("fs");const p=${JSON.stringify(counter)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,"utf8"):0)+1;fs.writeFileSync(p,String(n));console.log("side effect "+n)'`;
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
              { id: "call_replayed", name: "shell.exec", args: { command, cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              { id: "call_replayed", name: "shell.exec", args: { command, cwd } },
              { id: "call_fresh_list", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.filter(
            (message) =>
              message.role === "tool" &&
              message.content.includes("side effect 1"),
          ),
        ).toHaveLength(2);
        expect(
          request.messages.some((message) =>
            message.content.includes("side effect 2"),
          ),
        ).toBe(false);
        expect(
          request.messages.some((message) =>
            message.content.includes("did not run again"),
          ),
        ).toBe(true);
        expect(
          request.messages.filter(
            (message) =>
              message.role === "assistant" &&
              message.toolCalls?.some((call) => call.name === "shell.exec"),
          ),
        ).toHaveLength(2);
        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" && message.content.includes("append-counter.txt"),
          ),
        ).toBe(true);
        return {
          text: "counted once, replayed once",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    await expect(
      runAgentLoop("run the counter twice", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toBe("counted once, replayed once");
    await expect(readFile(counter, "utf8")).resolves.toBe("1");
    expect(streamMock).toHaveBeenCalledTimes(3);
  });

  it("does not re-execute a replayed id inside a parallel read group", async () => {
    await writeFile(join(cwd, "probe.txt"), "payload", "utf8");
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
              { id: "call_read_a", name: "fs.read", args: { path: join(cwd, "probe.txt") } },
              { id: "call_list_b", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              { id: "call_read_a", name: "fs.read", args: { path: join(cwd, "probe.txt") } },
              { id: "call_check_new", name: "tool.check", args: { tools: ["node"] } },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.filter(
            (message) =>
              message.role === "tool" && message.content.includes("payload"),
          ),
        ).toHaveLength(2);
        expect(
          request.messages.some((message) =>
            message.content.includes("did not run again"),
          ),
        ).toBe(true);
        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" && message.content.includes("node"),
          ),
        ).toBe(true);
        return {
          text: "read once, replayed once, checked tools",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    await expect(
      runAgentLoop("inspect the probe twice", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toBe("read once, replayed once, checked tools");
    expect(streamMock).toHaveBeenCalledTimes(3);
  });

  it("re-executes the same call id after the first attempt failed", async () => {
    await writeFile(join(cwd, "scene.txt"), "ready", "utf8");
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
              {
                id: "call_retry",
                name: "shell.exec",
                args: { command: "node -e 'process.exit(7)'", cwd },
              },
              { id: "call_scene_1", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        if (turn === 2) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_retry",
                name: "shell.exec",
                args: { command: "node -e 'console.log(\"recovered\")'", cwd },
              },
              { id: "call_scene_2", name: "fs.list", args: { path: cwd } },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.some((message) =>
            message.role === "tool" && message.content.includes("recovered"),
          ),
        ).toBe(true);
        expect(
          request.messages.some((message) =>
            message.content.includes("did not run again"),
          ),
        ).toBe(false);
        return {
          text: "retried and recovered",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    await expect(
      runAgentLoop("retry the failing command", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toBe("retried and recovered");
    expect(streamMock).toHaveBeenCalledTimes(3);
  });

  it("never executes truncated tool arguments even with terminal confirmation", async () => {
    let turn = 0;
    const truncated = `{"path":${JSON.stringify(cwd)}`;
    streamMock.mockImplementation(
      async (request: CompletionRequest): Promise<CompletionResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            provider: "openai",
            model: "gpt-test",
            toolCalls: [
              {
                id: "call_truncated",
                name: "fs.list",
                args: { _parseError: true, _raw: truncated },
                rawArguments: truncated,
              },
            ],
            finishReason: "tool_calls",
          };
        }
        expect(
          request.messages.some(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "call_truncated" &&
              /not valid JSON/i.test(message.content),
          ),
        ).toBe(true);
        return {
          text: "nothing ran from the truncated call",
          provider: "openai",
          model: "gpt-test",
          finishReason: "stop",
        };
      },
    );

    await expect(
      runAgentLoop("list the directory", {
        provider: "openai",
        model: "gpt-4o-mini",
        maxSteps: 5,
      }),
    ).resolves.toBe("nothing ran from the truncated call");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });
});
