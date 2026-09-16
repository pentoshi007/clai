import { describe, expect, it } from "vitest";
import { composeTurnMessages } from "../../src/agent/turn/setup/turn-messages.js";
import { buildTurnHistory } from "../../src/agent/tool-call-parser.js";
import { buildCompactionReplayMessages } from "../../src/agent/compaction-executor.js";
import { compactMessagesWithSummary } from "../../src/agent/context/compact-with-summary.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";
import { geminiBody } from "../../src/llm/gemini.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "../../src/llm/cache-affinity.js";
import type { ChatImage, ChatMessage, CompletionRequest } from "../../src/types.js";

const STABLE_SYSTEM = `SYSTEM CONSTITUTION\n${"Stable system rules.\n".repeat(200)}`;

const SAMPLE_IMAGE: ChatImage = {
  mediaType: "image/png",
  dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
};

const TOOLS = [
  {
    name: "fs.read",
    wireName: "fs_read",
    description: "Read file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "image.view",
    wireName: "image_view",
    description: "View image",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

function assembleTurn(
  prompt: string,
  history: ChatMessage[] | undefined,
  images?: ChatImage[],
): ChatMessage[] {
  const { messages } = composeTurnMessages({
    prompt,
    displayPrompt: undefined,
    images,
    history,
    mode: "agent",
    systemSections: ["AGENT MODE\nPerform and verify the requested work."],
    selectedSkillNames: [],
    nativeToolsActive: true,
    inputTokenBudget: undefined,
    stableSystemContent: () => STABLE_SYSTEM,
    instructionsBlock: undefined,
    skillsBlock: undefined,
    plan: undefined,
    planApproved: false,
  });
  return messages;
}

function appendToolRound(messages: ChatMessage[], id: string): void {
  messages.push({
    role: "assistant",
    content: "Reading file to inspect state",
    toolCalls: [{ id, name: "fs.read", args: { path: "package.json" } }],
  });
  messages.push({
    role: "tool",
    toolCallId: id,
    name: "fs.read",
    content: `{"name":"clai"}`,
    ok: true,
  });
}

function normalizeAnthropicBlocks(body: {
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}): unknown[] {
  return body.messages.flatMap(({ role, content }) => {
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return parts.map(({ cache_control: _, ...block }) => ({ role, ...block }));
  });
}

function normalizeGeminiParts(body: {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
}): unknown[] {
  return body.contents.flatMap(({ role, parts }) =>
    parts.map((part) => ({ role, ...part })),
  );
}

describe("multi-provider cache continuity across text, images, tools, and compaction", () => {
  it("preserves byte prefix continuity on Anthropic across image turns and compaction", async () => {
    let history: ChatMessage[] | undefined;
    const requests: CompletionRequest[] = [];

    const turn1Messages = assembleTurn("First user question", history);
    requests.push({ provider: "anthropic", model: "claude-sonnet-4-5", messages: turn1Messages, tools: TOOLS });
    history = buildTurnHistory(turn1Messages, "Answer 1");

    const turn2Messages = assembleTurn("Check this image", history, [SAMPLE_IMAGE]);
    requests.push({ provider: "anthropic", model: "claude-sonnet-4-5", messages: turn2Messages, tools: TOOLS });
    appendToolRound(turn2Messages, "call-1");
    requests.push({ provider: "anthropic", model: "claude-sonnet-4-5", messages: turn2Messages, tools: TOOLS });
    history = buildTurnHistory(turn2Messages, "Image analyzed");

    const turn3Messages = assembleTurn("Follow-up text question", history);
    requests.push({ provider: "anthropic", model: "claude-sonnet-4-5", messages: turn3Messages, tools: TOOLS });
    history = buildTurnHistory(turn3Messages, "Answer 3");

    const snapshot = {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-5",
      messages: turn3Messages,
      tools: TOOLS,
    };
    const replayMessages = buildCompactionReplayMessages(snapshot, history, "Summarize session");
    requests.push({ provider: "anthropic", model: "claude-sonnet-4-5", messages: replayMessages, tools: TOOLS });

    const wireBodies = requests.map((req) => JSON.parse(buildAnthropicBody(req, false)));

    for (let i = 1; i < wireBodies.length; i += 1) {
      const prev = wireBodies[i - 1]!;
      const curr = wireBodies[i]!;
      expect(curr.system).toEqual(prev.system);
      expect(curr.tools).toEqual(prev.tools);
      const prevBlocks = normalizeAnthropicBlocks(prev);
      const currBlocks = normalizeAnthropicBlocks(curr);
      expect(currBlocks.slice(0, prevBlocks.length)).toEqual(prevBlocks);
    }

    const compacted = await compactMessagesWithSummary(
      turn3Messages,
      async () => "## Summary\nPrior work completed.",
      { keepRecent: 2 },
    );
    history = buildTurnHistory(compacted.messages, "Post-compact answer");

    const postCompactMessages1 = assembleTurn("Post-compaction text turn", history);
    const postReq1: CompletionRequest = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: postCompactMessages1,
      tools: TOOLS,
    };
    history = buildTurnHistory(postCompactMessages1, "Answer post-compact 1");

    const postCompactMessages2 = assembleTurn("Post-compaction image turn", history, [SAMPLE_IMAGE]);
    const postReq2: CompletionRequest = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: postCompactMessages2,
      tools: TOOLS,
    };

    const postWire1 = JSON.parse(buildAnthropicBody(postReq1, false));
    const postWire2 = JSON.parse(buildAnthropicBody(postReq2, false));
    expect(postWire2.system).toEqual(postWire1.system);
    expect(postWire2.tools).toEqual(postWire1.tools);
    const postBlocks1 = normalizeAnthropicBlocks(postWire1);
    const postBlocks2 = normalizeAnthropicBlocks(postWire2);
    expect(postBlocks2.slice(0, postBlocks1.length)).toEqual(postBlocks1);
  });

  it("preserves byte prefix continuity on OpenAI across image turns and compaction", async () => {
    let history: ChatMessage[] | undefined;
    const requests: CompletionRequest[] = [];

    const turn1Messages = assembleTurn("First user question", history);
    requests.push({ provider: "openai", model: "gpt-4o", messages: turn1Messages, tools: TOOLS });
    history = buildTurnHistory(turn1Messages, "Answer 1");

    const turn2Messages = assembleTurn("Check this image", history, [SAMPLE_IMAGE]);
    requests.push({ provider: "openai", model: "gpt-4o", messages: turn2Messages, tools: TOOLS });
    appendToolRound(turn2Messages, "call-1");
    requests.push({ provider: "openai", model: "gpt-4o", messages: turn2Messages, tools: TOOLS });
    history = buildTurnHistory(turn2Messages, "Image analyzed");

    const turn3Messages = assembleTurn("Follow-up text question", history);
    requests.push({ provider: "openai", model: "gpt-4o", messages: turn3Messages, tools: TOOLS });
    history = buildTurnHistory(turn3Messages, "Answer 3");

    const snapshot = {
      provider: "openai" as const,
      model: "gpt-4o",
      messages: turn3Messages,
      tools: TOOLS,
    };
    const replayMessages = buildCompactionReplayMessages(snapshot, history, "Summarize session");
    requests.push({ provider: "openai", model: "gpt-4o", messages: replayMessages, tools: TOOLS });

    const wireBodies = requests.map((req) =>
      JSON.parse(
        buildChatBody({
          providerId: req.provider,
          model: req.model!,
          messages: req.messages,
          tools: req.tools,
          stream: false,
        }),
      ),
    );

    for (let i = 1; i < wireBodies.length; i += 1) {
      const prev = wireBodies[i - 1]!;
      const curr = wireBodies[i]!;
      expect(curr.tools).toEqual(prev.tools);
      expect(curr.messages.slice(0, prev.messages.length)).toEqual(prev.messages);
    }

    const compacted = await compactMessagesWithSummary(
      turn3Messages,
      async () => "## Summary\nPrior work completed.",
      { keepRecent: 2 },
    );
    history = buildTurnHistory(compacted.messages, "Post-compact answer");

    const postCompactMessages1 = assembleTurn("Post-compaction text turn", history);
    const postWire1 = JSON.parse(
      buildChatBody({
        providerId: "openai",
        model: "gpt-4o",
        messages: postCompactMessages1,
        tools: TOOLS,
        stream: false,
      }),
    );
    history = buildTurnHistory(postCompactMessages1, "Answer post-compact 1");

    const postCompactMessages2 = assembleTurn("Post-compaction image turn", history, [SAMPLE_IMAGE]);
    const postWire2 = JSON.parse(
      buildChatBody({
        providerId: "openai",
        model: "gpt-4o",
        messages: postCompactMessages2,
        tools: TOOLS,
        stream: false,
      }),
    );

    expect(postWire2.tools).toEqual(postWire1.tools);
    expect(postWire2.messages.slice(0, postWire1.messages.length)).toEqual(postWire1.messages);
  });

  it("preserves byte prefix continuity on Gemini across image turns and compaction", async () => {
    let history: ChatMessage[] | undefined;
    const requests: CompletionRequest[] = [];

    const turn1Messages = assembleTurn("First user question", history);
    requests.push({ provider: "gemini", model: "gemini-2.5-pro", messages: turn1Messages, tools: TOOLS });
    history = buildTurnHistory(turn1Messages, "Answer 1");

    const turn2Messages = assembleTurn("Check this image", history, [SAMPLE_IMAGE]);
    requests.push({ provider: "gemini", model: "gemini-2.5-pro", messages: turn2Messages, tools: TOOLS });
    appendToolRound(turn2Messages, "call-1");
    requests.push({ provider: "gemini", model: "gemini-2.5-pro", messages: turn2Messages, tools: TOOLS });
    history = buildTurnHistory(turn2Messages, "Image analyzed");

    const turn3Messages = assembleTurn("Follow-up text question", history);
    requests.push({ provider: "gemini", model: "gemini-2.5-pro", messages: turn3Messages, tools: TOOLS });
    history = buildTurnHistory(turn3Messages, "Answer 3");

    const snapshot = {
      provider: "gemini" as const,
      model: "gemini-2.5-pro",
      messages: turn3Messages,
      tools: TOOLS,
    };
    const replayMessages = buildCompactionReplayMessages(snapshot, history, "Summarize session");
    requests.push({ provider: "gemini", model: "gemini-2.5-pro", messages: replayMessages, tools: TOOLS });

    const wireBodies = requests.map((req) => JSON.parse(geminiBody(req, false)));

    for (let i = 1; i < wireBodies.length; i += 1) {
      const prev = wireBodies[i - 1]!;
      const curr = wireBodies[i]!;
      expect(curr.systemInstruction).toEqual(prev.systemInstruction);
      expect(curr.tools).toEqual(prev.tools);
      const prevParts = normalizeGeminiParts(prev);
      const currParts = normalizeGeminiParts(curr);
      expect(currParts.slice(0, prevParts.length)).toEqual(prevParts);
    }

    const compacted = await compactMessagesWithSummary(
      turn3Messages,
      async () => "## Summary\nPrior work completed.",
      { keepRecent: 2 },
    );
    history = buildTurnHistory(compacted.messages, "Post-compact answer");

    const postCompactMessages1 = assembleTurn("Post-compaction text turn", history);
    const postReq1: CompletionRequest = {
      provider: "gemini",
      model: "gemini-2.5-pro",
      messages: postCompactMessages1,
      tools: TOOLS,
    };
    history = buildTurnHistory(postCompactMessages1, "Answer post-compact 1");

    const postCompactMessages2 = assembleTurn("Post-compaction image turn", history, [SAMPLE_IMAGE]);
    const postReq2: CompletionRequest = {
      provider: "gemini",
      model: "gemini-2.5-pro",
      messages: postCompactMessages2,
      tools: TOOLS,
    };

    const postWire1 = JSON.parse(geminiBody(postReq1, false));
    const postWire2 = JSON.parse(geminiBody(postReq2, false));
    expect(postWire2.systemInstruction).toEqual(postWire1.systemInstruction);
    expect(postWire2.tools).toEqual(postWire1.tools);
    const postParts1 = normalizeGeminiParts(postWire1);
    const postParts2 = normalizeGeminiParts(postWire2);
    expect(postParts2.slice(0, postParts1.length)).toEqual(postParts1);
  });

  it.each(["openrouter", "explabs", "fireworks"] as const)(
    "preserves wire message prefixes and routing affinity on %s",
    async (providerId) => {
      await withSessionAffinity(`session-${providerId}-test`, async () => {
        let history: ChatMessage[] | undefined;
        let previousMessages: unknown[] | undefined;
        let previousKey: string | undefined;

        for (let turn = 1; turn <= 3; turn += 1) {
          const images = turn === 2 ? [SAMPLE_IMAGE] : undefined;
          const messages = assembleTurn(`Turn ${turn} question`, history, images);
          if (turn === 2) {
            appendToolRound(messages, `tool-${turn}`);
          }
          const body = JSON.parse(
            buildChatBody({
              providerId,
              model: "claude-sonnet-4-5",
              messages,
              tools: TOOLS,
              stream: false,
            }),
          );
          const wireMessages = body.messages as unknown[];
          if (previousMessages) {
            expect(wireMessages.slice(0, previousMessages.length)).toEqual(previousMessages);
          }
          const routingKey =
            body.session_id ?? body.prompt_cache_key ?? body.prompt_cache_isolation_key;
          expect(routingKey).toBeDefined();
          if (previousKey) {
            expect(routingKey).toBe(previousKey);
          }
          previousKey = routingKey;
          previousMessages = wireMessages;
          history = buildTurnHistory(messages, `Answer ${turn}`);
        }
      });
    },
  );

  it("preserves prefix continuity and isolated affinity for subagent research runs", async () => {
    const parentSession = "parent-sess-42";
    const subagentId = "subagent-99";
    const subagentSession = `${parentSession}:subagent:${subagentId}`;

    await withSessionAffinity(subagentSession, async () => {
      expect(currentSessionAffinity()).toBe(subagentSession);
      const subagentMessages: ChatMessage[] = [
        { role: "system", content: "You are an isolated read-only context gatherer." },
        { role: "user", content: JSON.stringify({ task: "research issue", cwd: "/tmp" }) },
      ];

      const body1 = JSON.parse(
        buildChatBody({
          providerId: "openrouter",
          model: "claude-sonnet-4-5",
          messages: subagentMessages,
          tools: TOOLS,
          stream: false,
        }),
      );

      appendToolRound(subagentMessages, "sub-call-1");

      const body2 = JSON.parse(
        buildChatBody({
          providerId: "openrouter",
          model: "claude-sonnet-4-5",
          messages: subagentMessages,
          tools: TOOLS,
          stream: false,
        }),
      );

      expect(body2.session_id).toBe(body1.session_id);
      expect(body1.session_id).toBe(sessionCacheAffinityKey(subagentSession));
      expect(body2.messages.slice(0, body1.messages.length)).toEqual(body1.messages);
    });
  });
});
