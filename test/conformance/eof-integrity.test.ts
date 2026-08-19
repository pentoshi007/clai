import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompletionResult, ToolDefinition } from "../../src/types.js";
import { providers } from "../../src/llm/router.js";
import { isPartialStreamError } from "../../src/llm/stream-terminal.js";
import { CONFORMANCE_ROUTES, type ConformanceRoute } from "./routes.js";
import { installTransport } from "./fake-transport.js";
import { buildEofResponse, EOF_CASES, type EofCase } from "./eof-fixtures.js";
import { TOOL_CANONICAL_NAME } from "./wire-fixtures.js";

const TOOL: ToolDefinition = {
  name: TOOL_CANONICAL_NAME,
  wireName: "fs_read",
  description: "read a file for conformance fixtures",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const FAMILY_ROUTES: ConformanceRoute[] = (() => {
  const seen = new Map<string, ConformanceRoute>();
  for (const route of CONFORMANCE_ROUTES) {
    if (!seen.has(route.family)) seen.set(route.family, route);
  }
  return [...seen.values()];
})();

async function streamTruncated(
  route: ConformanceRoute,
  eofCase: EofCase,
): Promise<CompletionResult> {
  installTransport(() => buildEofResponse(route.family, eofCase));
  const provider = providers[route.provider];
  const stream = provider.stream;
  if (!stream) throw new Error(`${route.id} declares no stream implementation`);
  return stream.call(
    provider,
    {
      provider: route.provider,
      model: route.model,
      messages: [{ role: "user", content: "conformance user turn" }],
      maxTokens: 256,
      tools: [TOOL],
      toolChoice: "auto",
      thinking: { enabled: true, effort: "low" },
    },
    route.auth,
    () => {},
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal integrity on abrupt EOF", () => {
  for (const route of FAMILY_ROUTES) {
    for (const eofCase of EOF_CASES) {
      it(`${route.family} rejects ${eofCase} without terminal proof`, async () => {
        const error = await streamTruncated(route, eofCase).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(isPartialStreamError(error)).toBe(true);
        if (!isPartialStreamError(error)) return;
        expect(Number.isFinite(error.answerBytes)).toBe(true);
        expect(Number.isFinite(error.reasoningBytes)).toBe(true);
        expect(Number.isFinite(error.toolArgumentBytes)).toBe(true);
      });
    }
  }
});

describe("truncated tool calls are never executable", () => {
  for (const route of FAMILY_ROUTES) {
    for (const eofCase of ["tool-id-only", "partial-tool-args"] as const) {
      it(`${route.family}/${eofCase} yields no complete tool call`, async () => {
        let result: CompletionResult | undefined;
        try {
          result = await streamTruncated(route, eofCase);
        } catch {
          return;
        }
        for (const call of result.toolCalls ?? []) {
          const keys = Object.keys(call.args ?? {});
          if (keys.length === 0) continue;
          expect(call.args?._parseError).toBe(true);
          expect(keys).not.toContain("path");
        }
      });
    }
  }
});

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const KIMI_ROUTES: ReadonlyArray<{
  readonly provider: "tokenrouter" | "fireworks" | "bynara";
  readonly model: string;
}> = [
  { provider: "tokenrouter", model: "moonshotai/kimi-k3" },
  { provider: "fireworks", model: "accounts/fireworks/models/kimi-k2p6" },
  { provider: "bynara", model: "kimi-k2.6" },
];

function finishReasonWithoutSentinel(model: string): readonly string[] {
  const chunk = (delta: unknown, finish?: string): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-kimi",
      object: "chat.completion.chunk",
      model,
      choices: [
        { index: 0, delta, ...(finish ? { finish_reason: finish } : {}) },
      ],
    })}\n\n`;
  return [chunk({ role: "assistant", content: "part" }), chunk({}, "stop")];
}

describe("a Kimi route needs the done sentinel, not finish_reason", () => {
  for (const route of KIMI_ROUTES) {
    it(`${route.provider} rejects finish_reason with no [DONE]`, async () => {
      installTransport(() => sseResponse(finishReasonWithoutSentinel(route.model)));
      const provider = providers[route.provider];
      const stream = provider.stream;
      if (!stream) throw new Error(`${route.provider} declares no stream`);
      const error = await stream
        .call(
          provider,
          {
            provider: route.provider,
            model: route.model,
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 256,
            thinking: { enabled: true, effort: "low" },
          },
          { apiKey: "synthetic-key", baseUrl: undefined },
          () => {},
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(isPartialStreamError(error)).toBe(true);
    });
  }

  it("accepts the same stream once [DONE] arrives", async () => {
    const route = KIMI_ROUTES[0]!;
    installTransport(() =>
      sseResponse([...finishReasonWithoutSentinel(route.model), "data: [DONE]\n\n"]),
    );
    const provider = providers[route.provider];
    const stream = provider.stream;
    if (!stream) throw new Error("no stream");
    const result = await stream.call(
      provider,
      {
        provider: route.provider,
        model: route.model,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 256,
        thinking: { enabled: true, effort: "low" },
      },
      { apiKey: "synthetic-key", baseUrl: undefined },
      () => {},
    );
    expect(result.text).toContain("part");
  });

  it("leaves a non-Kimi route accepting finish_reason", async () => {
    installTransport(() =>
      sseResponse(finishReasonWithoutSentinel("llama-3.3-70b-versatile")),
    );
    const provider = providers.nvidia;
    const stream = provider.stream;
    if (!stream) throw new Error("no stream");
    const result = await stream.call(
      provider,
      {
        provider: "nvidia",
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 256,
      },
      { apiKey: "synthetic-key", baseUrl: undefined },
      () => {},
    );
    expect(result.text).toContain("part");
  });
});
