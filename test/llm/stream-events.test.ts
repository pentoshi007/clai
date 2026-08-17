import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderId } from "../../src/types.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import { installTransport } from "../conformance/fake-transport.js";
import { keySlots, userTurn } from "../admission/admission-fixtures.js";
import {
  createStreamEventGuard,
  StreamEventProtocolError,
  type ProviderStreamEvent,
} from "../../src/llm/stream-events.js";

let slotsByProvider: Partial<Record<ProviderId, ProviderKeySlot[]>> = {};

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => ({
      keys: slotsByProvider[provider] ?? [],
      activeIndex: 0,
      source: "storage" as const,
    }),
    getProviderSecret: async (provider: ProviderId) => ({
      value: slotsByProvider[provider]?.[0]?.value ?? "",
      source: "storage" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "nvidia",
      providerFallback: false,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
    getActiveProviderEndpoint: () => "",
  };
});

const { providers, streamWithProvider } = await import("../../src/llm/router.js");

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function compatibleReasoningToolStream(): Response {
  const frames = [
    sseFrame({
      choices: [
        { index: 0, delta: { reasoning_content: "weighing the options" } },
      ],
    }),
    sseFrame({
      choices: [{ index: 0, delta: { content: "final answer" } }],
    }),
    sseFrame({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_stream_events",
                type: "function",
                function: { name: "fs_read", arguments: '{"path":"a.md"}' },
              },
            ],
          },
        },
      ],
    }),
    sseFrame({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
    "data: [DONE]\n\n",
  ];
  return new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  slotsByProvider = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream event guard", () => {
  it("accepts an ordered reasoning/answer/tool/usage/terminal sequence", () => {
    const guard = createStreamEventGuard();
    const ordered: ProviderStreamEvent[] = [
      { type: "reasoning_delta", text: "thinking" },
      { type: "answer_delta", text: "answer" },
      {
        type: "tool_call_started",
        index: 0,
        id: "call-1",
        name: "fs_read",
      },
      {
        type: "tool_arguments_delta",
        index: 0,
        argumentsBytes: 12,
      },
      {
        type: "tool_call_completed",
        index: 0,
        id: "call-1",
        name: "fs_read",
      },
      {
        type: "reasoning_artifact_available",
        artifacts: [],
      },
      { type: "provider_terminal", finishReason: "tool_calls" },
    ];
    for (const event of ordered) guard.accept(event);
    expect(guard.terminal).toBe(true);
  });

  it("allows usage after terminal but rejects any delta after terminal", () => {
    const guard = createStreamEventGuard();
    guard.accept({ type: "provider_terminal", finishReason: "stop" });
    guard.accept({
      type: "usage_observed",
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        exact: true,
      },
    });
    expect(() =>
      guard.accept({ type: "answer_delta", text: "late" }),
    ).toThrow(StreamEventProtocolError);
    expect(() =>
      guard.accept({ type: "reasoning_delta", text: "late" }),
    ).toThrow(StreamEventProtocolError);
    expect(() =>
      guard.accept({ type: "tool_arguments_delta", index: 0, argumentsBytes: 1 }),
    ).toThrow(StreamEventProtocolError);
  });

  it("rejects a second terminal and empty text deltas", () => {
    const guard = createStreamEventGuard();
    guard.accept({ type: "provider_terminal" });
    expect(() => guard.accept({ type: "provider_terminal" })).toThrow(
      StreamEventProtocolError,
    );

    const fresh = createStreamEventGuard();
    expect(() => fresh.accept({ type: "answer_delta", text: "" })).toThrow(
      StreamEventProtocolError,
    );
    expect(() => fresh.accept({ type: "reasoning_delta", text: "" })).toThrow(
      StreamEventProtocolError,
    );
  });
});

describe("router typed stream event synthesis", () => {
  it("emits the full typed event sequence and keeps text marker-free", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    installTransport(() => compatibleReasoningToolStream());

    const events: ProviderStreamEvent[] = [];
    const tokens: string[] = [];
    const result = await streamWithProvider(
      {
        provider: "nvidia",
        model: providers.nvidia.defaultModel,
        messages: userTurn(),
        onToolCallDelta: () => {},
        onStreamEvent: (event) => events.push(event),
      },
      (token) => tokens.push(token),
      { maxRetries: 0 },
    );

    expect(result.text).toBe("final answer");
    expect(result.text).not.toMatch(/[\ue000\ue001]/);
    expect(result.reasoningBlock?.text).toBe("weighing the options");
    expect(result.toolCalls?.[0]?.name).toBe("fs.read");

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("reasoning_delta");
    expect(types).toContain("answer_delta");
    expect(types.indexOf("answer_delta")).toBeLessThan(
      types.indexOf("tool_call_started"),
    );
    expect(types.filter((type) => type === "provider_terminal")).toEqual([
      "provider_terminal",
    ]);
    expect(types[types.length - 1]).toBe("provider_terminal");
    expect(types.indexOf("usage_observed")).toBeLessThan(
      types.indexOf("provider_terminal"),
    );

    const started = events.find((event) => event.type === "tool_call_started");
    expect(started).toMatchObject({
      index: 0,
      id: "call_stream_events",
      name: "fs.read",
    });
    const argsDelta = events.find(
      (event) => event.type === "tool_arguments_delta",
    );
    expect(argsDelta).toMatchObject({ index: 0, argumentsBytes: 15 });
    const completed = events.find(
      (event) => event.type === "tool_call_completed",
    );
    expect(completed).toMatchObject({
      index: 0,
      id: "call_stream_events",
      name: "fs.read",
    });
    const reasoning = events.find((event) => event.type === "reasoning_delta");
    expect(reasoning).toMatchObject({ text: "weighing the options" });

    expect(tokens.join("")).toBe("final answer");
  });
});
