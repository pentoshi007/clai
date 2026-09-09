import { afterEach, describe, expect, it, vi } from "vitest";

import { openAiCompatibleComplete } from "../../src/llm/http.js";
import {
  clearReasoningUnsupported,
  isReasoningUnsupported,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { completeWithProvider } from "../../src/llm/router.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../../src/llm/reasoning-artifacts.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse } from "../conformance/wire-fixtures.js";
import type { ChatMessage } from "../../src/types.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const DEEPSEEK_MISSING_BODY = JSON.stringify({
  error: {
    message:
      "The reasoning_content of the last assistant message must be passed back for reasoning models.",
    type: "invalid_request_error",
  },
});

function messagesWithToolTurn(provider: string, model: string): ChatMessage[] {
  const provenance = createReasoningArtifactProvenance({
    provider,
    model,
    dialect: "openai-compatible",
    endpoint: "https://api.tokenrouter.com/v1",
  });
  return [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "fs.read", arguments: { path: "a.txt" } },
      ],
      reasoningArtifacts: [
        createReasoningArtifact({
          kind: "plaintext",
          raw: "hidden chain of thought",
          displaySummary: "hidden chain of thought",
          provenance,
          replay: { scope: "tool-turn", persistence: "tool-turn" },
          position: { sequence: 1, placement: "before-tool-call", toolCallIndex: 0 },
        }),
      ],
    },
    { role: "tool", toolCallId: "call_1", name: "fs.read", content: "contents" },
    { role: "user", content: "now summarize it" },
  ];
}

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

function disabledScopeToolTurn(): ChatMessage[] {
  const provenance = createReasoningArtifactProvenance({
    provider: "tokenrouter",
    model: "deepseek/deepseek-v4-pro",
    dialect: "openai-compatible",
    endpoint: "https://api.tokenrouter.com/v1",
  });
  return [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_1", name: "fs.read", arguments: { path: "a.txt" } },
      ],
      reasoningArtifacts: [
        createReasoningArtifact({
          kind: "plaintext",
          raw: "hidden chain of thought",
          displaySummary: "hidden chain of thought",
          provenance,
          replay: { scope: "none", persistence: "never" },
          position: { sequence: 1, placement: "before-tool-call", toolCallIndex: 0 },
        }),
      ],
    },
    { role: "tool", toolCallId: "call_1", name: "fs.read", content: "contents" },
    { role: "user", content: "now summarize it" },
  ];
}

function assistantToolMessage(transport: {
  generations: Array<{ body?: unknown }>;
}): Record<string, unknown> {
  const wire = (transport.generations[0]?.body as Record<string, unknown>)[
    "messages"
  ] as Array<Record<string, unknown>>;
  const assistant = wire.find(
    (entry) => entry["role"] === "assistant" && entry["tool_calls"] !== undefined,
  );
  expect(assistant).toBeDefined();
  return assistant as Record<string, unknown>;
}

describe("a missing-reasoning_content rejection retries with the reasoning attached", () => {
  it("does not mark the model as reasoning-unsupported", async () => {
    let calls = 0;
    installTransport(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(JSON.parse(DEEPSEEK_MISSING_BODY), 400);
      }
      return jsonResponse({
        choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
      });
    });

    const result = await completeWithProvider({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
      messages: messagesWithToolTurn("tokenrouter", "deepseek/deepseek-v4-pro"),
      thinking: { enabled: true, effort: "high" },
    });

    expect(result.text).toBe("summary");
    expect(isReasoningUnsupported("tokenrouter", "deepseek/deepseek-v4-pro")).toBe(
      false,
    );
  });

  it("keeps the reasoning knob on the retry instead of stripping it", async () => {
    let calls = 0;
    const transport = installTransport(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(JSON.parse(DEEPSEEK_MISSING_BODY), 400);
      }
      return jsonResponse({
        choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
      });
    });

    await completeWithProvider({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
      messages: messagesWithToolTurn("tokenrouter", "deepseek/deepseek-v4-pro"),
      thinking: { enabled: true, effort: "high" },
    });

    const retry = transport.generations[1]?.body as Record<string, unknown>;
    expect(retry).toBeDefined();
    expect(retry["reasoning_effort"]).toBeDefined();
  });

  it("attaches reasoning_content that a scope gate would otherwise omit", async () => {
    const transport = installTransport(() =>
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );

    await openAiCompatibleComplete({
      provider: "TokenRouter",
      providerId: "tokenrouter",
      baseUrl: "https://api.tokenrouter.com/v1",
      apiKey: "synthetic-key",
      model: "deepseek/deepseek-v4-pro",
      messages: disabledScopeToolTurn(),
      reasoning: { enabled: true, effort: "high" },
      reasoningStyle: "openai",
      forceReasoningReplay: true,
    });

    expect(assistantToolMessage(transport)).toHaveProperty(
      "reasoning_content",
      "hidden chain of thought",
    );
  });

  it("omits it without the force flag, proving the gate is what changed", async () => {
    const transport = installTransport(() =>
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );

    await openAiCompatibleComplete({
      provider: "TokenRouter",
      providerId: "tokenrouter",
      baseUrl: "https://api.tokenrouter.com/v1",
      apiKey: "synthetic-key",
      model: "deepseek/deepseek-v4-pro",
      messages: disabledScopeToolTurn(),
      reasoning: { enabled: true, effort: "high" },
      reasoningStyle: "openai",
    });

    expect(assistantToolMessage(transport)).not.toHaveProperty("reasoning_content");
  });

  it("falls back to portable tool history when the required reasoning belongs to another route", async () => {
    let calls = 0;
    const transport = installTransport(() => {
      calls += 1;
      if (calls === 1) return jsonResponse(JSON.parse(DEEPSEEK_MISSING_BODY), 400);
      return jsonResponse({
        choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
      });
    });

    await completeWithProvider({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
      messages: messagesWithToolTurn("explabs", "deepseek-v4-flash"),
      thinking: { enabled: true, effort: "high" },
    });

    const initial = transport.generations[0]?.body as Record<string, unknown>;
    const initialMessages = initial["messages"] as Array<Record<string, unknown>>;
    expect(initialMessages.some((message) => message["role"] === "tool")).toBe(false);
    expect(initialMessages.some((message) => message["tool_calls"] !== undefined)).toBe(false);
    const retry = transport.generations[1]?.body as Record<string, unknown>;
    const messages = retry["messages"] as Array<Record<string, unknown>>;
    expect(messages.some((message) => message["role"] === "tool")).toBe(false);
    expect(messages.some((message) => message["tool_calls"] !== undefined)).toBe(false);
    expect(messages.map((message) => message["content"])).toContain(
      "[Tool result: fs_read]\ncontents",
    );
  });

  it("keeps compatible tool transactions native after switching providers", async () => {
    const messages = messagesWithToolTurn("explabs", "deepseek-v4-flash");
    messages.splice(3, 0,
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_2", name: "fs.read", args: { path: "b.txt" } }],
        reasoningArtifacts: [
          createReasoningArtifact({
            kind: "plaintext",
            raw: "read the second file",
            provenance: createReasoningArtifactProvenance({
              provider: "tokenrouter",
              model: "deepseek/deepseek-v4-pro",
              dialect: "openai-compatible",
              endpoint: "https://api.tokenrouter.com/v1",
            }),
            replay: { scope: "tool-turn", persistence: "tool-turn" },
            position: { sequence: 1, placement: "before-tool-call", toolCallIndex: 0 },
          }),
        ],
      },
      { role: "tool", toolCallId: "call_2", name: "fs.read", content: "more contents" },
    );
    const transport = installTransport(() =>
      jsonResponse({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] }),
    );

    await completeWithProvider({
      provider: "tokenrouter",
      model: "deepseek/deepseek-v4-pro",
      messages,
      thinking: { enabled: true, effort: "high" },
    });

    const wire = (transport.generations[0]?.body as Record<string, unknown>)["messages"] as Array<Record<string, unknown>>;
    expect(wire.find((message) => message["tool_calls"] !== undefined)).toMatchObject({
      tool_calls: [expect.objectContaining({ id: "call_2" })],
    });
    expect(wire).toContainEqual({
      role: "user",
      content: "[Tool result: fs_read]\ncontents",
    });
  });

  it("retries legacy tool history as portable text when no reasoning artifact exists", async () => {
    let calls = 0;
    const transport = installTransport(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse(JSON.parse(DEEPSEEK_MISSING_BODY), 400)
        : jsonResponse({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] });
    });

    await completeWithProvider({
      provider: "explabs",
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "read a file" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", name: "fs.read", content: "contents" },
        { role: "user", content: "summarize" },
      ],
      thinking: { enabled: true, effort: "high" },
    });

    const retry = transport.generations[1]?.body as Record<string, unknown>;
    const wire = retry["messages"] as Array<Record<string, unknown>>;
    expect(wire.some((message) => message["tool_calls"] !== undefined)).toBe(false);
    expect(wire.some((message) => message["role"] === "tool")).toBe(false);
  });

  it("surfaces an invalid same-route continuation without degrading reasoning effort", async () => {
    const transport = installTransport(() =>
      jsonResponse(
        { error: { message: "thinking signature verification failed" } },
        400,
      ),
    );
    const statuses: string[] = [];

    await expect(
      completeWithProvider({
        provider: "tokenrouter",
        model: "deepseek/deepseek-v4-pro",
        messages: messagesWithToolTurn("tokenrouter", "deepseek/deepseek-v4-pro"),
        thinking: { enabled: true, effort: "high" },
        onStatus: (message) => statuses.push(message),
      }),
    ).rejects.toThrow("thinking signature verification failed");

    expect(transport.generations).toHaveLength(1);
    expect(isReasoningUnsupported("tokenrouter", "deepseek/deepseek-v4-pro")).toBe(false);
    expect(statuses.some((message) => /reasoning effort|without them/.test(message))).toBe(false);
  });
});
