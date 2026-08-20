import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompletionResult } from "../../src/types.js";
import { providers } from "../../src/llm/router.js";
import { isPartialStreamError } from "../../src/llm/stream-terminal.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS } from "../../src/llm/provider-profile.js";
import { installTransport } from "./fake-transport.js";
import { textStreamResponse } from "./wire-fixtures.js";
import { CONFORMANCE_ROUTES, type ConformanceRoute } from "./routes.js";

const CHAT_ROUTE = CONFORMANCE_ROUTES.find(
  (route) => route.family === "chat_completions",
) as ConformanceRoute;

const ANSWER = "hello from a gateway that never closes the stream";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const ROLE_FRAME = sse({ choices: [{ index: 0, delta: { role: "assistant" } }] });

function contentFrame(text: string): string {
  return sse({ choices: [{ index: 0, delta: { content: text } }] });
}

function usageFrame(): string {
  return sse({
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 301, total_tokens: 312 },
  });
}

async function streamFrames(frames: string[]): Promise<CompletionResult> {
  installTransport(() => textStreamResponse(frames));
  const provider = providers[CHAT_ROUTE.provider];
  const stream = provider.stream;
  if (!stream) throw new Error(`${CHAT_ROUTE.id} declares no stream implementation`);
  return stream.call(
    provider,
    {
      provider: CHAT_ROUTE.provider,
      model: CHAT_ROUTE.model,
      messages: [{ role: "user", content: "say hello" }],
      maxTokens: 256,
    },
    CHAT_ROUTE.auth,
    () => {},
  );
}

async function streamError(frames: string[]): Promise<unknown> {
  return streamFrames(frames).then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage-chunk is an accepted terminal proof", () => {
  it("is declared alongside the done sentinel and finish reason", () => {
    expect(CHAT_COMPLETIONS_TERMINAL_PROOFS).toEqual([
      "done-sentinel",
      "finish-reason",
      "usage-chunk",
    ]);
  });

  it("accepts a final usage frame followed by EOF with no [DONE] and no finish_reason", async () => {
    const result = await streamFrames([ROLE_FRAME, contentFrame(ANSWER), usageFrame()]);
    expect(result.text).toBe(ANSWER);
    expect(result.finishReason).toBeUndefined();
    expect(result.usage?.promptTokens).toBe(11);
    expect(result.usage?.completionTokens).toBe(301);
  });

  it("accepts a usage frame trailed by a non-usage bookkeeping frame", async () => {
    const result = await streamFrames([
      ROLE_FRAME,
      contentFrame(ANSWER),
      usageFrame(),
      sse({ choices: [], cost: "0" }),
    ]);
    expect(result.text).toBe(ANSWER);
  });

  it("still prefers an explicit finish_reason when the provider sends one", async () => {
    const result = await streamFrames([
      ROLE_FRAME,
      contentFrame(ANSWER),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      usageFrame(),
    ]);
    expect(result.finishReason).toBe("stop");
  });
});

describe("usage-chunk never masks a truncated stream", () => {
  it("rejects content with no terminal frame at all", async () => {
    expect(isPartialStreamError(await streamError([ROLE_FRAME, contentFrame(ANSWER)]))).toBe(true);
  });

  it("rejects a usage frame that is followed by more generation then EOF", async () => {
    const error = await streamError([
      ROLE_FRAME,
      contentFrame(ANSWER),
      usageFrame(),
      contentFrame(" and then it kept talking"),
    ]);
    expect(isPartialStreamError(error)).toBe(true);
  });

  it("rejects a usage frame that reports only an input counter", async () => {
    const error = await streamError([
      ROLE_FRAME,
      contentFrame(ANSWER),
      sse({ choices: [], usage: { prompt_tokens: 11 } }),
    ]);
    expect(isPartialStreamError(error)).toBe(true);
  });

  it("rejects a usage payload that arrives attached to a live choice", async () => {
    const error = await streamError([
      ROLE_FRAME,
      sse({
        choices: [{ index: 0, delta: { content: ANSWER } }],
        usage: { prompt_tokens: 11, completion_tokens: 301, total_tokens: 312 },
      }),
    ]);
    expect(isPartialStreamError(error)).toBe(true);
  });

  it("rejects a bookkeeping frame that carries no usage counters", async () => {
    const error = await streamError([
      ROLE_FRAME,
      contentFrame(ANSWER),
      sse({ choices: [], cost: "0" }),
    ]);
    expect(isPartialStreamError(error)).toBe(true);
  });
});
