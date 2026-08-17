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
