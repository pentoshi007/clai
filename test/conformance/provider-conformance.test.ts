import { afterEach, describe, expect, it, vi } from "vitest";

import { providerIds } from "../../src/types.js";
import type { CompletionRequest, CompletionResult, ToolDefinition } from "../../src/types.js";
import { providers } from "../../src/llm/router.js";
import { CONFORMANCE_ROUTES, type ConformanceRoute } from "./routes.js";
import { installFakeTransport } from "./fake-transport.js";
import {
  ANSWER_TEXT,
  COMPLETION_TOKENS,
  CACHED_PROMPT_TOKENS,
  ERROR_MESSAGE,
  PROMPT_TOKENS,
  REASONING_TEXT,
  TOOL_ARGS,
  TOOL_CANONICAL_NAME,
  TOOL_FINISH_REASON,
  UNSUPPORTED_SCENARIOS,
  type ConformanceScenario,
  type WireFamily,
  type WireMode,
} from "./wire-fixtures.js";

const SCENARIOS: readonly ConformanceScenario[] = [
  "answer",
  "reasoning",
  "tools",
  "usage",
  "error",
  "terminal",
];

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

function requestFor(
  route: ConformanceRoute,
  scenario: ConformanceScenario,
): CompletionRequest {
  return {
    provider: route.provider,
    model: route.model,
    messages: [
      { role: "system", content: "conformance system prompt" },
      { role: "user", content: "conformance user turn" },
    ],
    maxTokens: 512,
    temperature: 0.2,
    ...(scenario === "reasoning"
      ? { thinking: { enabled: true, effort: "low" as const } }
      : {}),
    ...(scenario === "tools" ? { tools: [TOOL], toolChoice: "auto" as const } : {}),
  };
}

async function run(
  route: ConformanceRoute,
  mode: WireMode,
  scenario: ConformanceScenario,
): Promise<CompletionResult> {
  const provider = providers[route.provider];
  const request = requestFor(route, scenario);
  if (mode === "complete") return provider.complete(request, route.auth);
  const stream = provider.stream;
  if (!stream) throw new Error(`${route.id} declares no stream implementation`);
  return stream.call(provider, request, route.auth, () => {});
}

function skipReason(
  family: WireFamily,
  scenario: ConformanceScenario,
): string | undefined {
  return UNSUPPORTED_SCENARIOS[family]?.[scenario];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider conformance matrix", () => {
  it("maps every built-in provider to a tested wire family", () => {
    const covered = new Set(CONFORMANCE_ROUTES.map((route) => route.provider));
    const missing = providerIds.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  for (const route of CONFORMANCE_ROUTES) {
    describe(`${route.id} (${route.family})`, () => {
      for (const mode of ["complete", "stream"] as const) {
        for (const scenario of SCENARIOS) {
          const reason = skipReason(route.family, scenario);
          const title = `${mode}/${scenario}`;
          if (reason) {
            it.skip(`${title} — unsupported: ${reason}`, () => {});
            continue;
          }
          it(title, async () => {
            const transport = installFakeTransport({
              family: route.family,
              mode,
              scenario,
              model: route.model,
            });

            if (scenario === "error") {
              await expect(run(route, mode, scenario)).rejects.toThrow(
                new RegExp(ERROR_MESSAGE, "i"),
              );
              expect(transport.generations.length).toBeGreaterThanOrEqual(1);
              return;
            }

            const result = await run(route, mode, scenario);

            expect(transport.generations.length).toBeGreaterThanOrEqual(1);
            const expectedUrl =
              mode === "stream"
                ? route.streamUrlContains ?? route.urlContains
                : route.urlContains;
            expect(transport.generations[0]!.url).toContain(expectedUrl);
            expect(transport.generations[0]!.method).toBe("POST");
            expect(result.provider).toBe(route.provider);
            expect(result.text).toContain(ANSWER_TEXT);

            if (scenario === "reasoning") {
              expect(result.text).not.toContain(REASONING_TEXT);
              if (result.reasoningBlock?.text !== undefined) {
                expect(result.reasoningBlock.text).toContain(REASONING_TEXT);
              } else {
                expect(result.reasoningArtifacts?.length ?? 0).toBeGreaterThan(
                  0,
                );
              }
            }

            if (scenario === "tools") {
              expect(result.toolCalls?.length ?? 0).toBe(1);
              expect(result.toolCalls?.[0]?.name).toBe(TOOL_CANONICAL_NAME);
              expect(result.toolCalls?.[0]?.args).toEqual(TOOL_ARGS);
              expect(result.finishReason).toBe(
                TOOL_FINISH_REASON[route.family][mode],
              );
            }

            if (scenario === "usage" || scenario === "answer") {
              expect(result.usage?.exact).toBe(true);
              expect(result.usage?.promptTokens).toBe(PROMPT_TOKENS);
              expect(result.usage?.completionTokens).toBe(COMPLETION_TOKENS);
            }

            if (scenario === "terminal") {
              expect(result.text.length).toBeGreaterThan(0);
            }
          });
        }
      }
    });
  }
});

describe("provider conformance cache telemetry baseline", () => {
  const byFamily = new Map<WireFamily, ConformanceRoute>();
  for (const route of CONFORMANCE_ROUTES) {
    if (!byFamily.has(route.family)) byFamily.set(route.family, route);
  }

  for (const [family, route] of byFamily) {
    it(`${family} reports cached prompt tokens or documents the gap`, async () => {
      installFakeTransport({
        family,
        mode: "complete",
        scenario: "usage",
        model: route.model,
      });
      const result = await run(route, "complete", "usage");
      const cached = result.usage?.cachedPromptTokens;
      if (family === "chat_completions" || family === "anthropic_messages") {
        expect(cached).toBe(CACHED_PROMPT_TOKENS);
      } else {
        expect(cached).toBeUndefined();
      }
    });
  }
});
