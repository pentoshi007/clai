import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent/runner.js";
import { REQUEST_CONTEXT_PREFIX } from "../src/llm/system-messages.js";
import {
  renderAgentSystemPrompt,
  renderAskSystemPrompt,
  renderCompactAgentSystemPrompt,
} from "../src/prompts/index.js";
import { updateConfig } from "../src/store/config.js";
import { getToolDefinitions } from "../src/tools/definitions/selection.js";
import { forgetRtk } from "../src/tools/rtk/binary.js";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../src/types.js";
import { FAKE_RTK_MARKER, installFakeRtk, type FakeRtk } from "./helpers/fake-rtk.js";

const streamMock = vi.fn();

vi.mock("../src/llm/router.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/router.js")>()),
  streamWithProvider: (request: CompletionRequest, onToken: (token: string) => void) =>
    streamMock(request, onToken),
  completeWithProvider: vi.fn(),
}));

vi.mock("../src/commands/providers.js", () => ({
  ensureProviderConfigured: vi.fn(async () => undefined),
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

interface Step {
  readonly rtk: boolean;
  readonly command?: string;
}

const PROVIDER = "openai";
const MODEL = "gpt-4o-mini";

interface SentRequest {
  readonly tools: CompletionRequest["tools"];
  readonly messages: ChatMessage[];
}

const TOGGLED_SESSION: readonly Step[] = [
  { rtk: false, command: "grep alpha notes.txt" },
  { rtk: true, command: "grep alpha notes.txt" },
  { rtk: true, command: "diff notes.txt other.txt" },
  { rtk: false, command: "grep beta notes.txt" },
  { rtk: false },
];

const PLAIN_SESSION: readonly Step[] = TOGGLED_SESSION.map((step) => ({ ...step, rtk: false }));

const autoConfirm = {
  confirmTool: async () => true,
  confirmPlan: async () => true,
  confirmMany: async (items: Array<{ id: string }>) =>
    Object.fromEntries(items.map((item) => [item.id, true as const])),
};

const toolMessages = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => message.role === "tool");

const stableShape = (messages: readonly ChatMessage[]): unknown[] =>
  messages
    .filter((message) => !(message.role === "system" && message.content.startsWith(REQUEST_CONTEXT_PREFIX)))
    .map((message) =>
      message.role === "tool"
        ? { role: message.role, toolCallId: message.toolCallId, name: message.name }
        : message,
    );

describe.skipIf(process.platform === "win32")("rtk keeps the provider cache prefix intact", () => {
  let rtk: FakeRtk;
  let workdir: string;
  let previousCwd: string;
  const sessions: AbortController[] = [];

  beforeEach(async () => {
    previousCwd = process.cwd();
    workdir = await mkdtemp(join(tmpdir(), "clai-rtk-cache-"));
    await writeFile(join(workdir, "notes.txt"), "alpha\nbeta\n");
    await writeFile(join(workdir, "other.txt"), "alpha\ngamma\n");
    process.chdir(workdir);
    rtk = await installFakeRtk();
    forgetRtk();
    streamMock.mockReset();
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.abort();
    updateConfig({ rtk: false });
    forgetRtk();
    await rtk.dispose();
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  const runSession = async (steps: readonly Step[]): Promise<SentRequest[]> => {
    const sent: SentRequest[] = [];
    const session = new AbortController();
    sessions.push(session);
    let index = 0;
    streamMock.mockImplementation(
      async (request: CompletionRequest, onToken: (token: string) => void): Promise<CompletionResult> => {
        const step = steps[index];
        if (!step) {
          throw new Error(`unexpected model request ${index + 1}; the script has ${steps.length} steps`);
        }
        sent.push({
          tools: structuredClone(request.tools),
          messages: structuredClone(request.messages),
        });
        index += 1;
        updateConfig({ rtk: step.rtk });
        if (step.command) {
          return {
            text: "",
            provider: PROVIDER,
            model: MODEL,
            toolCalls: [{ id: `call_${index}`, name: "shell.exec", args: { command: step.command } }],
            finishReason: "tool_calls",
          };
        }
        onToken("done");
        return { text: "done", provider: PROVIDER, model: MODEL, finishReason: "stop" };
      },
    );
    updateConfig({ rtk: false });
    const answer = await runAgentLoop("check the notes", {
      provider: PROVIDER,
      model: MODEL,
      maxSteps: steps.length + 3,
      signal: session.signal,
      confirm: autoConfirm as never,
    });
    expect(answer).toContain("done");
    expect(sent).toHaveLength(steps.length);
    return sent;
  };

  it("never changes tools, prompts, or prior messages when compression is toggled mid-session", async () => {
    const plain = await runSession(PLAIN_SESSION);
    const toggled = await runSession(TOGGLED_SESSION);

    for (const [index, request] of toggled.entries()) {
      expect(request.tools).toEqual(plain[index]!.tools);
      expect(stableShape(request.messages)).toEqual(stableShape(plain[index]!.messages));
      if (index === 0) continue;
      const previous = toggled[index - 1]!;
      expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    }
  });

  it("sends only compressed results to the model while the transcript keeps the requested commands", async () => {
    const toggled = await runSession(TOGGLED_SESSION);
    const last = toggled.at(-1)!.messages;

    const calls = last.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.args.command)).toEqual(
      TOGGLED_SESSION.flatMap((step) => (step.command ? [step.command] : [])),
    );
    expect(JSON.stringify(calls)).not.toContain("rtk");

    const compressed = toolMessages(last).map((message) => message.content.includes(FAKE_RTK_MARKER));
    expect(compressed).toEqual([false, true, true, false]);
  });

  it("keeps every request byte-identical to an uncompressed session up to the first tool result", async () => {
    const plain = await runSession(PLAIN_SESSION);
    const toggled = await runSession(TOGGLED_SESSION);

    expect(toggled[1]!.messages.length).toBe(plain[1]!.messages.length);
    expect(stableShape(toggled[1]!.messages)).toEqual(stableShape(plain[1]!.messages));
    expect(toolMessages(toggled[1]!.messages).map((m) => m.content.includes(FAKE_RTK_MARKER))).toEqual([false]);
  });
});

describe("rtk configuration is invisible to everything the provider caches", () => {
  afterEach(() => {
    updateConfig({ rtk: false });
  });

  const snapshot = (): string =>
    JSON.stringify({
      tools: getToolDefinitions(),
      compactTools: getToolDefinitions({ compact: true }),
      askTools: getToolDefinitions({ askMode: true }),
      agentPrompts: [
        renderAgentSystemPrompt("shell.exec, fs.read", { stableEnvironment: true }),
        renderAgentSystemPrompt("shell.exec, fs.read", { stableEnvironment: true, nativeTools: true }),
        renderAgentSystemPrompt("shell.exec, fs.read", {
          stableEnvironment: true,
          nativeTools: true,
          slimNative: false,
          pentest: true,
        }),
      ],
      compactPrompts: [
        renderCompactAgentSystemPrompt("shell.exec", { stableEnvironment: true }),
        renderCompactAgentSystemPrompt("shell.exec", { stableEnvironment: true, nativeTools: true }),
      ],
      askPrompts: [
        renderAskSystemPrompt({ stableEnvironment: true }),
        renderAskSystemPrompt({ stableEnvironment: true, nativeTools: true }),
      ],
    });

  it("renders identical tool schemas and system prompts with compression on and off", () => {
    updateConfig({ rtk: false });
    const off = snapshot();
    updateConfig({ rtk: true });
    const on = snapshot();
    expect(on).toBe(off);
  });

  it("never mentions rtk in tool schemas or system prompts", () => {
    expect(snapshot()).not.toMatch(/\brtk\b/i);
  });
});
