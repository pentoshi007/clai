import { describe, expect, it } from "vitest";

import { chatCompletionsBodyFromPlan } from "../../src/llm/http.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import {
  classifyPrefixAffinity,
  fingerprintFinalRequest,
} from "../../src/llm/request-fingerprint.js";
import { buildCompactionReplayMessages } from "../../src/agent/compaction-executor.js";
import type {
  ChatMessage,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../src/types.js";
import { SNAPSHOT_TOOLS } from "./request-cases.js";

const PROVIDER: ProviderId = "fireworks";
const MODEL = "accounts/fireworks/models/kimi-k2p6";

const COMPACTION_PROMPT =
  "Summarize the conversation so far into continuation memory.";

const TURN_MESSAGES: readonly ChatMessage[] = [
  { role: "system", content: "stable system prefix for cache reuse" },
  { role: "user", content: "first user turn" },
  { role: "assistant", content: "first assistant answer" },
  { role: "user", content: "second user turn" },
];

const HISTORY_TAIL: readonly ChatMessage[] = [
  { role: "assistant", content: "second assistant answer" },
];

function snapshot(): SuccessfulRequestSnapshot {
  return {
    provider: PROVIDER,
    model: MODEL,
    messages: TURN_MESSAGES,
    temperature: 0.2,
    thinking: { enabled: true, effort: "max" },
    tools: SNAPSHOT_TOOLS,
    toolChoice: "auto",
    parallelToolCalls: true,
  };
}

function fingerprintFor(input: {
  messages: readonly ChatMessage[];
  temperature?: number | undefined;
  thinking?: SuccessfulRequestSnapshot["thinking"];
  tools?: SuccessfulRequestSnapshot["tools"];
  toolChoice?: SuccessfulRequestSnapshot["toolChoice"];
  parallelToolCalls?: boolean | undefined;
  maxTokens?: number | undefined;
}) {
  const plan = compileRequestPlan({
    provider: PROVIDER,
    model: MODEL,
    messages: input.messages,
    stream: false,
    ...(input.thinking ? { reasoning: input.thinking } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
    ...(input.parallelToolCalls !== undefined
      ? { parallelToolCalls: input.parallelToolCalls }
      : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
  return fingerprintFinalRequest(
    { provider: PROVIDER, model: MODEL },
    chatCompletionsBodyFromPlan(plan),
  );
}

function turnFingerprint() {
  const base = snapshot();
  return fingerprintFor({
    messages: base.messages,
    temperature: base.temperature,
    thinking: base.thinking,
    tools: base.tools,
    toolChoice: base.toolChoice,
    parallelToolCalls: base.parallelToolCalls,
    maxTokens: 32_768,
  });
}

function snapshotReplayFingerprint() {
  const base = snapshot();
  return fingerprintFor({
    messages: buildCompactionReplayMessages(
      base,
      [...base.messages, ...HISTORY_TAIL],
      COMPACTION_PROMPT,
    ),
    temperature: base.temperature,
    thinking: base.thinking,
    tools: base.tools,
    toolChoice: base.toolChoice,
    parallelToolCalls: base.parallelToolCalls,
    maxTokens: 4_096,
  });
}

const COMPACTION_TOOL_SELECTION: SuccessfulRequestSnapshot["tools"] = [
  SNAPSHOT_TOOLS[0]!,
];

function legacyFallbackFingerprint() {
  return fingerprintFor({
    messages: [
      { role: "system", content: "compaction system content" },
      ...TURN_MESSAGES.slice(1),
      ...HISTORY_TAIL,
      { role: "user", content: COMPACTION_PROMPT },
    ],
    temperature: 0.1,
    thinking: { enabled: false, effort: "low" },
    tools: COMPACTION_TOOL_SELECTION,
    toolChoice: "none",
    maxTokens: 4_096,
  });
}

describe("turn to compaction prefix affinity", () => {
  it("classifies the snapshot replay as an exact append of the turn request", () => {
    expect(
      classifyPrefixAffinity(turnFingerprint(), snapshotReplayFingerprint()),
    ).toBe("exact_append_eligible");
  });

  it("keeps the turn request its own exact prefix", () => {
    expect(classifyPrefixAffinity(turnFingerprint(), turnFingerprint())).toBe(
      "exact_append_eligible",
    );
  });

  it("classifies the legacy no-snapshot fallback as not eligible", () => {
    expect(
      classifyPrefixAffinity(turnFingerprint(), legacyFallbackFingerprint()),
    ).toBe("not_eligible");
  });

  it("classifies a replay that rewrites stable history as partial only", () => {
    const base = snapshot();
    const rewritten = fingerprintFor({
      messages: [
        base.messages[0]!,
        { role: "user", content: "first user turn, edited" },
        ...base.messages.slice(2),
        ...HISTORY_TAIL,
        { role: "user", content: COMPACTION_PROMPT },
      ],
      temperature: base.temperature,
      thinking: base.thinking,
      tools: base.tools,
      toolChoice: base.toolChoice,
      parallelToolCalls: base.parallelToolCalls,
      maxTokens: 4_096,
    });
    expect(classifyPrefixAffinity(turnFingerprint(), rewritten)).toBe(
      "partial_prefix_eligible",
    );
  });

  it("measures the message prefix and tool schemas, not the settings section", () => {
    const base = snapshot();
    const settingsOnlyDivergence = fingerprintFor({
      messages: [...base.messages, ...HISTORY_TAIL, { role: "user", content: COMPACTION_PROMPT }],
      temperature: 0.1,
      thinking: { enabled: false, effort: "low" },
      tools: base.tools,
      toolChoice: "none",
      maxTokens: 4_096,
    });
    expect(
      classifyPrefixAffinity(turnFingerprint(), settingsOnlyDivergence),
    ).toBe("exact_append_eligible");
  });
});
