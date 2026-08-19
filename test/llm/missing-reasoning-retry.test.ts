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
});
