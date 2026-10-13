import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionResult, ProviderId } from "../../src/types.js";
import { createTurnHistoryWriter } from "../../src/agent/turn/history-writer.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  ProviderError,
} from "../../src/llm/http.js";
import {
  isInvalidReasoningContentError,
  isMissingReasoningContentError,
} from "../../src/llm/reasoning-errors.js";
import { compatibleArtifactPolicyFor } from "../../src/llm/wire/reasoning-artifacts.js";
import { getSession, saveSession } from "../../src/store/history.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse, textStreamResponse } from "../conformance/wire-fixtures.js";

const ENDPOINT = "https://reasoning-history.example/v1";
const REASONING = "Original reasoning\nwith exact whitespace.  ";
const MISSING = {
  error: {
    param: "messages[3].reasoning_content",
    type: "invalid_request_error",
    message: "Upstream request failed: [missing_required_parameter] Missing required parameter: 'messages[3].reasoning_content'. This model needs the reasoning of every earlier assistant message: send back the 'reasoning_content' returned with that message.",
  },
};

interface WireMessage {
  readonly role: string;
  readonly content: string | null;
  readonly reasoning_content?: string;
}

interface WireBody {
  readonly messages: readonly WireMessage[];
  readonly prompt_cache_key?: string;
  readonly session_id?: string;
  readonly reasoning_effort?: string;
}

const ROUTES: ReadonlyArray<readonly [ProviderId, string]> = [
  ["free", "cat-jam-free"],
  ["free", "unlisted-next-generation-free"],
  ["openrouter", "unlisted-next-generation"],
  ["nvidia", "unlisted-next-generation"],
  ["kimi", "kimi-k3"],
];

function response(stream: boolean): Response {
  const message = { content: "Verified answer", reasoning_content: REASONING };
  if (!stream) {
    return jsonResponse({ choices: [{ message, finish_reason: "stop" }] });
  }
  return textStreamResponse([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

function historyWriter(messages: ChatMessage[]) {
  return createTurnHistoryWriter({
    messages,
    images: undefined,
    sanitizeAssistantText: (text) => text,
    visibleCommitted: () => true,
    writeAssistantMessage: () => undefined,
  });
}

async function generate(
  providerId: ProviderId,
  model: string,
  messages: ChatMessage[],
  stream: boolean,
  baseUrl = ENDPOINT,
): Promise<CompletionResult> {
  const options = {
    provider: "Fixture",
    providerId,
    model,
    baseUrl,
    apiKey: "fixture",
    messages,
    maxTokens: 256,
  };
  return stream
    ? { ...await openAiCompatibleStream({ ...options, onToken: () => undefined }), provider: providerId, model }
    : { ...await openAiCompatibleComplete(options), provider: providerId, model };
}

function strictTransport(stream: boolean) {
  return installTransport((request) => {
    const body = request.body as WireBody;
    const missing = body.messages.some(
      (message) => message.role === "assistant" && message.reasoning_content === undefined,
    );
    return missing ? jsonResponse(MISSING, 400) : response(stream);
  });
}

function expectStablePrefix(previous: WireBody, next: WireBody): void {
  expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
  expect(next.prompt_cache_key).toBe(previous.prompt_cache_key);
  expect(next.session_id).toBe(previous.session_id);
  expect(next.reasoning_effort).toBe(previous.reasoning_effort);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([false, true])("reasoning history (stream=%s)", (stream) => {
  it.each(ROUTES)("preserves exact final reasoning and append-only prefixes for %s/%s", async (provider, model) => {
    const transport = strictTransport(stream);
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable instructions" },
      { role: "user", content: "First question" },
    ];
    const writer = historyWriter(messages);
    for (let turn = 0; turn < 3; turn += 1) {
      const result = await generate(provider, model, messages, stream);
      writer.pushAssistantHistory(result.text, result);
      messages.push({ role: "user", content: `Follow-up ${turn}` });
    }
    const bodies = transport.generations.map((request) => request.body as WireBody);
    expect(bodies).toHaveLength(3);
    expectStablePrefix(bodies[0]!, bodies[1]!);
    expectStablePrefix(bodies[1]!, bodies[2]!);
    expect(bodies[2]?.messages.filter((message) => message.role === "assistant"))
      .toEqual([
        { role: "assistant", content: "Verified answer", reasoning_content: REASONING },
        { role: "assistant", content: "Verified answer", reasoning_content: REASONING },
      ]);
  });

  it("replays original reasoning after saving and resuming the session", async () => {
    const transport = strictTransport(stream);
    const messages: ChatMessage[] = [{ role: "user", content: "First question" }];
    const result = await generate("free", "cat-jam-free", messages, stream);
    historyWriter(messages).pushAssistantHistory(result.text, result);
    const saved = await saveSession(messages, "reasoning history fixture");
    const resumed = await getSession(saved.id);
    expect(resumed?.messages[1]?.reasoningArtifacts?.[0]?.raw).toBe(REASONING);
    const restored = resumed!.messages;
    restored.push({ role: "user", content: "Continue after resume" });
    await generate("free", "cat-jam-free", restored, stream);
    expect(transport.generations).toHaveLength(2);
    expect((transport.generations[1]?.body as WireBody).messages[1]?.reasoning_content)
      .toBe(REASONING);
  });

});

describe.each([false, true])("reasoning history isolation (stream=%s)", (stream) => {
  it("does not fabricate reasoning when the provider returns none", async () => {
    const transport = installTransport(() => jsonResponse({
      choices: [{ message: { content: "Visible answer only" }, finish_reason: "stop" }],
    }));
    const messages: ChatMessage[] = [{ role: "user", content: "First question" }];
    const result = await generate("free", "unlisted-free", messages, stream);
    historyWriter(messages).pushAssistantHistory(result.text, result);
    expect(messages[1]).not.toHaveProperty("reasoningArtifacts");
    messages.push({ role: "user", content: "Continue" });
    await generate("free", "unlisted-free", messages, stream);
    expect((transport.generations[1]?.body as WireBody).messages[1])
      .toEqual({ role: "assistant", content: "Visible answer only" });
  });

  it("does not send retained reasoning to another provider, model, or endpoint", async () => {
    const transport = installTransport(() => response(stream));
    const messages: ChatMessage[] = [{ role: "user", content: "First question" }];
    const result = await generate("free", "unlisted-free", messages, stream);
    historyWriter(messages).pushAssistantHistory(result.text, result);
    const original = structuredClone(messages);
    messages.push({ role: "user", content: "Continue" });
    await generate("nvidia", "unlisted-free", messages, stream);
    await generate("free", "different-free", messages, stream);
    await generate("free", "unlisted-free", messages, stream, "https://other.example/v1");
    for (const request of transport.generations.slice(1)) {
      expect(JSON.stringify(request.body)).not.toContain(REASONING.replaceAll("\n", "\\n"));
      expect((request.body as WireBody).messages.find((message) => message.role === "assistant"))
        .not.toHaveProperty("reasoning_content");
    }
    expect(messages.slice(0, original.length)).toEqual(original);
  });
});

describe("reasoning-history error classification", () => {
  it.each([400, 422])("recognizes the exact upstream missing-parameter error (%s)", (status) => {
    const error = new ProviderError("Upstream rejected the request", status, JSON.stringify(MISSING));
    expect(isMissingReasoningContentError(error)).toBe(true);
    expect(isInvalidReasoningContentError(error)).toBe(false);
  });

  it.each([
    "Missing required parameter: 'messages[3].reasoning_content'",
    "Missing required field: messages[0].reasoning_content",
    "Missing required parameter: `messages.12.reasoning_content`",
    "reasoning_content is required",
    "Missing reasoning_content",
    "reasoning_content must be sent back",
  ])("recognizes %s", (message) => {
    expect(isMissingReasoningContentError(new ProviderError(message, 400))).toBe(true);
  });

  it.each([
    "Missing required parameter: 'messages[3].content'",
    "Missing required parameter: 'content'; reasoning_content is unsupported",
    "Unknown parameter: reasoning_content",
    "Invalid reasoning_content signature",
  ])("does not treat unrelated validation as missing history: %s", (message) => {
    expect(isMissingReasoningContentError(new ProviderError(message, 400))).toBe(false);
  });

  it.each([401, 403, 429, 500])("does not adapt non-validation failures (%s)", (status) => {
    expect(isMissingReasoningContentError(new ProviderError("reasoning_content is required", status)))
      .toBe(false);
  });
});

it("retains unfamiliar contracts without overriding explicit no-preservation models", () => {
  expect(compatibleArtifactPolicyFor("unknown").persistence).toBe("all-turns");
  expect(compatibleArtifactPolicyFor("required").persistence).toBe("all-turns");
  expect(compatibleArtifactPolicyFor("supported").persistence).toBe("tool-turn");
  expect(compatibleArtifactPolicyFor("unsupported").persistence).toBe("tool-turn");
});
