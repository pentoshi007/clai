import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, CompletionRequest, ToolDefinition } from "../../src/types.js";
import { appendAssistantWithTools, appendToolResult } from "../../src/agent/tool-history.js";
import { anthropicProvider } from "../../src/llm/anthropic.js";
import { geminiProvider } from "../../src/llm/gemini.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
} from "../../src/llm/http.js";
import { metaProvider } from "../../src/llm/meta.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
  createReasoningArtifactReplayTarget,
  reasoningArtifactsForPersistence,
} from "../../src/llm/reasoning-artifacts.js";
import { toAnthropicToolMessages } from "../../src/llm/adapters/anthropic-tools.js";
import { toGeminiToolContents } from "../../src/llm/adapters/gemini-tools.js";
import { toOpenAiToolMessages } from "../../src/llm/adapters/openai-tools.js";
import { installTransport } from "./fake-transport.js";
import { jsonResponse, textStreamResponse } from "./wire-fixtures.js";

const TOOL: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "read a synthetic file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const REQUEST: CompletionRequest = {
  model: "synthetic-model",
  messages: [{ role: "user", content: "inspect the synthetic file" }],
  tools: [TOOL],
  toolChoice: "auto",
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function anthropicResponse(): Response {
  return jsonResponse({
    content: [
      {
        type: "thinking",
        thinking: "inspect first",
        signature: "anthropic-signature",
        provider_extra: { stable: "raw" },
      },
      {
        type: "tool_use",
        id: "provider-tool-id",
        name: "fs_read",
        input: { path: "synthetic.md" },
      },
    ],
    stop_reason: "tool_use",
  });
}

function anthropicStreamResponse(): Response {
  return textStreamResponse([
    sse({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "inspect first" },
    }),
    sse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "anthropic-signature" },
    }),
    sse({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "provider-tool-id", name: "fs_read" },
    }),
    sse({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"synthetic.md"}' },
    }),
    sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
    sse({ type: "message_stop" }),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("T210 reasoning artifact capture", () => {
  it("captures signed Anthropic state in complete and stream responses and rebinds it to the durable call id", async () => {
    installTransport(() => anthropicResponse());
    const complete = await anthropicProvider.complete(
      { ...REQUEST, model: "claude-synthetic" },
      { apiKey: "synthetic-key" },
    );
    const completeArtifact = complete.reasoningArtifacts?.[0];
    expect(completeArtifact?.kind).toBe("signed");
    expect(completeArtifact?.raw).toEqual({
      type: "thinking",
      thinking: "inspect first",
      signature: "anthropic-signature",
      provider_extra: { stable: "raw" },
    });
    expect(completeArtifact?.position).toMatchObject({
      sequence: 0,
      placement: "before-tool-call",
      toolCallIndex: 0,
    });

    vi.unstubAllGlobals();
    installTransport(() => anthropicStreamResponse());
    const streamed = await anthropicProvider.stream!(
      { ...REQUEST, model: "claude-synthetic" },
      { apiKey: "synthetic-key" },
      () => {},
    );
    expect(streamed.reasoningArtifacts?.[0]?.raw).toEqual({
      type: "thinking",
      thinking: "inspect first",
      signature: "anthropic-signature",
    });

    const history: ChatMessage[] = [];
    appendAssistantWithTools(
      history,
      "",
      [{ id: "durable-tool-id", name: "fs.read", args: { path: "synthetic.md" } }],
      streamed.reasoningBlock,
      streamed.reasoningArtifacts,
    );
    expect(history[0]?.reasoningArtifacts?.[0]?.position.toolCallId).toBe(
      "durable-tool-id",
    );
    const assistant = toAnthropicToolMessages(history, {
      target: createReasoningArtifactReplayTarget({
        provider: "anthropic",
        model: "claude-synthetic",
        dialect: "anthropic-messages",
        endpoint: "https://api.anthropic.com/v1",
      }),
    })[0]!;
    const blocks = assistant.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: "thinking",
      thinking: "inspect first",
      signature: "anthropic-signature",
    });
  });

  it("captures Gemini thought state at each parallel/sequential function-call position in complete and stream responses", async () => {
    const parts = [
      { thought: true, text: "reason before first" },
      {
        functionCall: { id: "gemini-a", name: "fs_read", args: { path: "a.md" } },
        thoughtSignature: "gemini-signature-a",
      },
      { thought: true, text: "reason before second" },
      {
        functionCall: { id: "gemini-b", name: "fs_read", args: { path: "b.md" } },
        thoughtSignature: "gemini-signature-b",
      },
    ];
    installTransport(() =>
      jsonResponse({
        candidates: [{ content: { parts }, finishReason: "STOP" }],
      }),
    );
    const complete = await geminiProvider.complete(
      { ...REQUEST, model: "gemini-synthetic" },
      { apiKey: "synthetic-key" },
    );
    expect(complete.reasoningArtifacts?.map((artifact) => artifact.position)).toEqual([
      { sequence: 0, placement: "before-tool-call", toolCallIndex: 0 },
      { sequence: 1, placement: "on-tool-call", toolCallIndex: 0 },
      { sequence: 2, placement: "before-tool-call", toolCallIndex: 1 },
      { sequence: 3, placement: "on-tool-call", toolCallIndex: 1 },
    ]);

    vi.unstubAllGlobals();
    installTransport(() =>
      textStreamResponse([
        ...parts.map((part) => sse({ candidates: [{ content: { parts: [part] } }] })),
        sse({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }),
      ]),
    );
    const streamed = await geminiProvider.stream!(
      { ...REQUEST, model: "gemini-synthetic" },
      { apiKey: "synthetic-key" },
      () => {},
    );
    const history: ChatMessage[] = [];
    appendAssistantWithTools(
      history,
      "",
      streamed.toolCalls ?? [],
      streamed.reasoningBlock,
      streamed.reasoningArtifacts,
    );
    const modelParts = toGeminiToolContents(history, {
      target: createReasoningArtifactReplayTarget({
        provider: "gemini",
        model: "gemini-synthetic",
        dialect: "gemini-generate-content",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
      }),
    })[0]?.parts as Array<{
      text?: string;
      thought?: boolean;
      thoughtSignature?: string;
      functionCall?: { id?: string };
    }>;
    expect(modelParts).toEqual([
      { text: "reason before first", thought: true },
      {
        functionCall: { name: "fs_read", args: { path: "a.md" }, id: "gemini-a" },
        thoughtSignature: "gemini-signature-a",
      },
      { text: "reason before second", thought: true },
      {
        functionCall: { name: "fs_read", args: { path: "b.md" }, id: "gemini-b" },
        thoughtSignature: "gemini-signature-b",
      },
    ]);
  });

  it("captures OpenRouter details and compatible Gemini signatures without reducing them to display text", async () => {
    const details = {
      type: "reasoning.encrypted",
      id: "detail-1",
      payload: { opaque: ["a", "b"], unknown_extension: true },
    };
    installTransport(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              reasoning_content: "check the file",
              reasoning_details: details,
              extra_content: { google: { thought_signature: "compatible-signature" } },
              tool_calls: [
                {
                  id: "compatible-tool",
                  type: "function",
                  function: { name: "fs_read", arguments: '{"path":"a.md"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const complete = await openAiCompatibleComplete({
      provider: "OpenRouter synthetic",
      providerId: "openrouter",
      baseUrl: "https://synthetic.openrouter.example/v1",
      apiKey: "synthetic-key",
      model: "synthetic-compatible",
      messages: REQUEST.messages,
      tools: REQUEST.tools,
      toolChoice: "auto",
    });
    expect(complete.reasoningArtifacts?.map((artifact) => artifact.kind)).toEqual([
      "plaintext",
      "structured-details",
      "thought-signature",
    ]);
    expect(complete.reasoningArtifacts?.[1]?.raw).toEqual(details);

    const history: ChatMessage[] = [];
    appendAssistantWithTools(
      history,
      "",
      complete.toolCalls ?? [],
      complete.reasoningBlock,
      complete.reasoningArtifacts,
    );
    const wire = toOpenAiToolMessages(history, (message) => message.content, {
      target: createReasoningArtifactReplayTarget({
        provider: "openrouter",
        model: "synthetic-compatible",
        dialect: "openai-compatible",
        endpoint: "https://synthetic.openrouter.example/v1",
      }),
    })[0] as Record<string, unknown>;
    expect(wire.reasoning_content).toBe("check the file");
    expect(wire.reasoning_details).toEqual(details);
    expect(wire.extra_content).toEqual({
      google: { thought_signature: "compatible-signature" },
    });

    vi.unstubAllGlobals();
    installTransport(() =>
      textStreamResponse([
        sse({ choices: [{ delta: { reasoning_content: "streamed plain" } }] }),
        sse({ choices: [{ delta: { reasoning_details: details } }] }),
        sse({
          choices: [
            {
              delta: {
                extra_content: { google: { thought_signature: "streamed-signature" } },
              },
            },
          ],
        }),
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "compatible-tool",
                    type: "function",
                    function: { name: "fs_read", arguments: '{"path":"a.md"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const streamed = await openAiCompatibleStream({
      provider: "Kimi synthetic",
      providerId: "bynara",
      baseUrl: "https://synthetic.kimi.example/v1",
      apiKey: "synthetic-key",
      model: "synthetic-compatible",
      messages: REQUEST.messages,
      tools: REQUEST.tools,
      toolChoice: "auto",
      onToken: () => {},
    });
    expect(streamed.reasoningArtifacts?.[1]?.raw).toEqual(details);
    expect(
      streamed.reasoningArtifacts?.find(
        (artifact) => artifact.kind === "thought-signature",
      )?.position,
    ).toMatchObject({ placement: "on-tool-call", toolCallIndex: 0 });
  });

  it("captures Qwen and Kimi plaintext reasoning from the common compatible transport", async () => {
    for (const providerId of ["qwen-cloud", "bynara"] as const) {
      installTransport(() =>
        jsonResponse({
          choices: [
            {
              message: { content: "answer", reasoning: `${providerId} plaintext` },
              finish_reason: "stop",
            },
          ],
        }),
      );
      const result = await openAiCompatibleComplete({
        provider: providerId,
        providerId,
        baseUrl: `https://synthetic.${providerId}.example/v1`,
        apiKey: "synthetic-key",
        model: "synthetic-compatible",
        messages: REQUEST.messages,
      });
      expect(result.reasoningArtifacts?.[0]?.kind).toBe("plaintext");
      expect(result.reasoningArtifacts?.[0]?.raw).toBe(`${providerId} plaintext`);
      vi.unstubAllGlobals();
    }
  });

  it("keeps the full Meta encrypted item through an active tool-loop replay", async () => {
    const encryptedItem = {
      type: "reasoning",
      id: "meta-reasoning-id",
      summary: [{ type: "summary_text", text: "inspect the file" }],
      encrypted_content: "meta-encrypted-payload",
      provider_extra: { nested: [1, { retained: true }] },
    };
    installTransport(() =>
      jsonResponse({
        output: [
          encryptedItem,
          {
            type: "function_call",
            id: "meta-tool",
            call_id: "meta-tool",
            name: "fs_read",
            arguments: '{"path":"meta.md"}',
          },
        ],
      }),
    );
    const result = await metaProvider.complete(
      { ...REQUEST, model: "meta-synthetic" },
      { apiKey: "synthetic-key" },
    );
    const artifact = result.reasoningArtifacts?.[0];
    expect(artifact?.kind).toBe("encrypted");
    expect(artifact?.raw).toEqual(encryptedItem);
    expect(artifact?.position).toMatchObject({
      placement: "before-tool-call",
      toolCallIndex: 0,
    });

    const history: ChatMessage[] = [];
    appendAssistantWithTools(
      history,
      "",
      result.toolCalls ?? [],
      result.reasoningBlock,
      result.reasoningArtifacts,
    );
    appendToolResult(history, "meta-tool", "synthetic result", "fs.read", true);

    vi.unstubAllGlobals();
    const replay = installTransport(() =>
      jsonResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      }),
    );
    await metaProvider.complete(
      { model: "meta-synthetic", messages: history },
      { apiKey: "synthetic-key" },
    );
    const input = (replay.generations[0]?.body as { input?: unknown[] }).input ?? [];
    const encryptedIndex = input.findIndex(
      (item) => JSON.stringify(item) === JSON.stringify(encryptedItem),
    );
    const callIndex = input.findIndex(
      (item) => (item as { type?: string }).type === "function_call",
    );
    expect(encryptedIndex).toBeGreaterThanOrEqual(0);
    expect(encryptedIndex).toBeLessThan(callIndex);
  });

  it("retains final-turn artifacts only when their explicit persistence policy permits it", () => {
    const provenance = createReasoningArtifactProvenance({
      provider: "openrouter",
      model: "synthetic-compatible",
      dialect: "openai-compatible",
      endpoint: "https://synthetic.openrouter.example/v1",
    });
    const never = createReasoningArtifact({
      kind: "plaintext",
      raw: "never retain",
      provenance,
      replay: { scope: "all-history", persistence: "never" },
    });
    const toolTurn = createReasoningArtifact({
      kind: "plaintext",
      raw: "tool retain",
      provenance,
      replay: { scope: "all-history", persistence: "tool-turn" },
    });
    const finalTurn = createReasoningArtifact({
      kind: "plaintext",
      raw: "final retain",
      provenance,
      replay: { scope: "all-history", persistence: "final-turn" },
    });
    const allTurns = createReasoningArtifact({
      kind: "plaintext",
      raw: "always retain",
      provenance,
      replay: { scope: "all-history", persistence: "all-turns" },
    });

    expect(
      reasoningArtifactsForPersistence({
        artifacts: [never, toolTurn, finalTurn, allTurns],
        hasToolCalls: false,
      })?.map((artifact) => artifact.raw),
    ).toEqual(["final retain", "always retain"]);
    expect(
      reasoningArtifactsForPersistence({
        artifacts: [never, toolTurn],
        hasToolCalls: true,
      })?.map((artifact) => artifact.raw),
    ).toEqual(["never retain", "tool retain"]);
  });
});
