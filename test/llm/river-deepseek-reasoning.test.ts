import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASONING_STEP_MAX_TOKENS, resolveStepMaxTokens } from "../../src/agent/reliability-policy.js";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { resolveBuiltInProfile, routeOutputTokenLimit } from "../../src/llm/provider-profiles.js";
import { reasoningArtifactsForPersistence } from "../../src/llm/reasoning-artifacts.js";
import { riverProvider } from "../../src/llm/river.js";
import { RIVER_DEFAULT_MODEL, RIVER_GLM_MODEL } from "../../src/llm/river-models.js";
import type { ChatMessage } from "../../src/types.js";
import { REQUEST, sse, TOOL, transport } from "./river-fixtures.js";

let sequence = 0;
let apiKey: string;

beforeEach(() => {
  apiKey = `rv_deepseek_reasoning_${++sequence}`;
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

const thinking = { enabled: true, effort: "max" as const };

function finalAnswer(reasoning: string, content: string) {
  return sse([
    { choices: [{ delta: { reasoning_content: reasoning } }] },
    { choices: [{ delta: { content }, finish_reason: "stop" }] },
  ]);
}

describe("River DeepSeek reasoning budget and replay", () => {
  it.each([RIVER_DEFAULT_MODEL, `${RIVER_DEFAULT_MODEL}-1017`])(
    "preserves final-answer reasoning for %s",
    (model) => {
      expect(resolveBuiltInProfile({ provider: "river", model }).reasoning.finalTurnPreservation)
        .toBe("required");
    },
  );

  it("leaves River GLM reasoning policy unchanged", () => {
    expect(resolveBuiltInProfile({ provider: "river", model: RIVER_GLM_MODEL }).reasoning.finalTurnPreservation)
      .toBe("unsupported");
  });

  it("sends the large reasoning budget for an agent step at max effort", async () => {
    const maxTokens = resolveStepMaxTokens({
      nativeToolsActive: true,
      toolsAttached: true,
      thinkingEnabled: true,
      outputTokenLimit: routeOutputTokenLimit("river", RIVER_DEFAULT_MODEL),
    });
    const { generations } = transport(() => finalAnswer("Plan the scene.", "Done"));
    await riverProvider.stream!({ ...REQUEST, tools: [TOOL], thinking, maxTokens }, { apiKey }, () => {});
    expect(JSON.parse(generations[0]!.body)).toMatchObject({
      max_tokens: REASONING_STEP_MAX_TOKENS,
      reasoning_effort: "max",
    });
  });

  it("persists final-answer reasoning and replays it on the next tool-bearing request", async () => {
    const reasoning = "Remember the camera rig decision for later steps.";
    const { generations } = transport(() => finalAnswer(reasoning, "Scene ready"));
    const first = await riverProvider.stream!({ ...REQUEST, tools: [TOOL], thinking }, { apiKey }, () => {});
    const persisted = reasoningArtifactsForPersistence({
      artifacts: first.reasoningArtifacts,
      hasToolCalls: false,
    });
    expect(persisted?.map((artifact) => artifact.raw)).toEqual([reasoning]);

    const history: ChatMessage[] = [
      ...REQUEST.messages,
      { role: "assistant", content: first.text, reasoningArtifacts: persisted },
      { role: "user", content: "Add shadows" },
    ];
    await riverProvider.stream!({ ...REQUEST, messages: history, tools: [TOOL], thinking }, { apiKey }, () => {});
    const replayed = (JSON.parse(generations[1]!.body) as { messages: Record<string, unknown>[] }).messages;
    expect(replayed[2]).toMatchObject({ role: "assistant", content: "Scene ready", reasoning_content: reasoning });
  });
});
