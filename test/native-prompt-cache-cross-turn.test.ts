import { afterEach, describe, expect, it, vi } from "vitest";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { buildTurnHistory } from "../src/agent/tool-call-parser.js";
import { upsertSessionStateMessage } from "../src/agent/session-state.js";
import { buildAnthropicBody } from "../src/llm/anthropic.js";
import { mantleProvider } from "../src/llm/aws-mantle.js";
import { geminiBody } from "../src/llm/gemini.js";
import { REQUEST_CONTEXT_PREFIX } from "../src/llm/system-messages.js";
import type { ChatMessage } from "../src/types.js";

interface WireBody {
  system?: unknown;
  systemInstruction?: unknown;
  messages?: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }>;
  contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
}

const SYSTEM = `SYSTEM CONSTITUTION\n${"Stable rules.\n".repeat(400)}`;

function turnMessages(turn: number, history?: ChatMessage[]): ChatMessage[] {
  const { messages } = composeTurnMessages({
    prompt: `revision ${turn}`,
    displayPrompt: undefined,
    images: undefined,
    history,
    mode: "agent",
    systemSections: ["AGENT MODE\nPerform and verify the requested work."],
    selectedSkillNames: [],
    nativeToolsActive: true,
    inputTokenBudget: undefined,
    stableSystemContent: () => SYSTEM,
    instructionsBlock: undefined,
    skillsBlock: undefined,
    plan: undefined,
    planApproved: false,
  });
  for (let step = 0; step < 12; step += 1) {
    const id = `call-${turn}-${step}`;
    messages.push({
      role: "assistant",
      content: `inspect ${turn}.${step}`,
      toolCalls: [{ id, name: "fs.read", args: { path: `${step}.ts` } }],
    });
    messages.push({
      role: "tool",
      toolCallId: id,
      name: "fs.read",
      content: `result ${turn}.${step}`,
      ok: true,
    });
    upsertSessionStateMessage(messages, `revision ${turn}, step ${step}`);
  }
  return messages;
}

function conversationBlocks(body: WireBody): unknown[] {
  if (body.contents) {
    return body.contents.flatMap(({ role, parts }) =>
      parts.map((part) => ({ role, ...part })),
    );
  }
  return body.messages!.flatMap(({ role, content }) => {
    const blocks = typeof content === "string"
      ? [{ type: "text", text: content }]
      : content;
    return blocks.map(({ cache_control: _, ...block }) => ({ role, ...block }));
  });
}

describe("native provider wire cache prefix across completed revisions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { provider: "anthropic", stream: false },
    { provider: "anthropic", stream: true },
    { provider: "gemini", stream: false },
    { provider: "aws-mantle", stream: false },
    { provider: "aws-mantle", stream: true },
  ] as const)(
    "$provider (stream=$stream) keeps all prior context behind an unchanged system prefix",
    async ({ provider, stream }) => {
      const captured: WireBody[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
        captured.push(JSON.parse(String(init.body)) as WireBody);
        if (stream) {
          return new Response([
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }));
      const serialize = async (messages: ChatMessage[]): Promise<WireBody> => {
        if (provider === "gemini") {
          return JSON.parse(geminiBody({ provider, model: "gemini-2.5-pro", messages }));
        }
        if (provider === "anthropic") {
          return JSON.parse(buildAnthropicBody({ provider, model: "claude-sonnet-4-5", messages }, stream));
        }
        const request = {
          provider,
          model: "anthropic.claude-sonnet-4-6",
          messages,
        };
        if (stream) {
          await mantleProvider.stream!(request, { apiKey: "test-key" }, () => {});
        } else {
          await mantleProvider.complete(request, { apiKey: "test-key" });
        }
        return captured.at(-1)!;
      };

      let history: ChatMessage[] | undefined;
      let previous: WireBody | undefined;
      for (let turn = 1; turn <= 3; turn += 1) {
        const messages = turnMessages(turn, history);
        const before = structuredClone(messages);
        const body = await serialize(messages);
        const serialized = JSON.stringify(body);
        expect(messages).toEqual(before);
        expect(JSON.stringify(body.system ?? body.systemInstruction)).not.toContain(REQUEST_CONTEXT_PREFIX);
        if (previous) {
          expect(body.system ?? body.systemInstruction).toEqual(previous.system ?? previous.systemInstruction);
          const prefix = conversationBlocks(previous);
          expect(conversationBlocks(body).slice(0, prefix.length)).toEqual(prefix);
        }
        for (let revision = 1; revision <= turn; revision += 1) {
          expect(serialized).toContain(`revision ${revision}`);
          for (let step = 0; step < 12; step += 1) {
            expect(serialized).toContain(`result ${revision}.${step}`);
          }
        }
        expect(serialized.split(REQUEST_CONTEXT_PREFIX)).toHaveLength(turn + 1);
        previous = body;
        history = buildTurnHistory(messages, `completed revision ${turn}`);
      }
    },
  );
});
