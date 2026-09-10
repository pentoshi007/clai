import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTurnHistoryWriter } from "../src/agent/turn/history-writer.js";
import { upsertResponderResultLedger } from "../src/agent/responder-context.js";
import { buildTurnHistory } from "../src/agent/tool-call-parser.js";
import { buildChatBody, chatCompletionsBodyFromPlan } from "../src/llm/http.js";
import { compileRequestPlan } from "../src/llm/request-plan.js";
import { cachePolicyFields } from "../src/llm/cache-policy-fields.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { ChatMessage, ProviderId } from "../src/types.js";
import type { ResponderNotification } from "../src/tools/jobs.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import { clearReasoningUnsupported, markReasoningUnsupported } from "../src/llm/capabilities.js";

function notification(id: string): ResponderNotification {
  const artifact = { path: `/${id}.log`, chunks: [], bytes: 42, droppedBytes: 0, redacted: false, sha256: id };
  return {
    id, ownerSessionId: "cache-session", jobId: id, status: "exited",
    createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z", analyzedAt: "2026-01-01T00:00:02Z",
    stdoutArtifact: artifact, stderrArtifact: artifact, commandDisplay: "inspect",
    wakeOnCompletion: true, responder: true,
  };
}

describe("compatible cache prefix during internal updates", () => {
  let customProviders: ReturnType<typeof getConfig>["customProviders"];
  beforeEach(() => {
    customProviders = getConfig().customProviders;
    updateConfig({ customProviders: [{ id: "future-gateway", displayName: "Future gateway", baseUrl: "https://gateway.invalid/v1", defaultModel: "claude-opus-4-6" }] });
  });
  afterEach(() => updateConfig({ customProviders }));
  it.each(["agentrouter", "openrouter", "openai", "future-gateway"])("%s retains recovery and consumed-result prefixes after a new prompt", (providerId) => {
    const messages: ChatMessage[] = [
      { role: "system", content: "stable instructions" },
      { role: "user", content: "original request" },
    ];
    const writer = createTurnHistoryWriter({
      messages, images: undefined, sanitizeAssistantText: (s) => s,
      visibleCommitted: () => false, writeAssistantMessage: () => {},
    });
    const wire = (input: ChatMessage[]) => JSON.parse(buildChatBody({ providerId: providerId as ProviderId, model: "claude-opus-4-6", messages: input, stream: true })).messages as unknown[];
    writer.upsertActionCycleRecovery("try the first action");
    upsertResponderResultLedger(messages, notification("job-one"));
    const first = wire(messages);
    messages.push({ role: "assistant", content: "first result" });
    writer.upsertActionCycleRecovery("try the next action");
    upsertResponderResultLedger(messages, notification("job-two"));
    const second = wire(messages);
    expect(second.slice(0, first.length)).toEqual(first);
    const count = messages.length;
    writer.upsertActionCycleRecovery("try the next action");
    upsertResponderResultLedger(messages, notification("job-two"));
    expect(messages).toHaveLength(count);
    const followup: ChatMessage[] = [messages[0]!, ...buildTurnHistory(messages, "done"), { role: "user", content: "revise that result" }];
    expect(wire(followup).slice(0, second.length)).toEqual(second);
    expect(JSON.stringify(followup)).toContain("try the first action");
    expect(JSON.stringify(followup)).toContain("job-one");
  });
});

describe("custom compatible cache policy fields", () => {
  const input = {
    provider: "future-gateway" as ProviderId, model: "future-model",
    messages: [{ role: "user", content: "first request" }] as ChatMessage[],
    policy: { kind: "affinity-key" as const, affinityField: "conversation_key", isolationField: "isolation_key" },
  };
  it("uses stable isolated session keys across revisions and distinguishes auxiliary traffic", async () => {
    const keys = await Promise.all(["a", "b"].map((session) => withSessionAffinity(session, async () => {
      const before = cachePolicyFields(input);
      await Promise.resolve();
      expect(cachePolicyFields({ ...input, messages: [{ role: "user", content: "revision" }] })).toEqual(before);
      expect(before.isolation_key).toBe(before.conversation_key);
      expect(cachePolicyFields({ ...input, purpose: "auxiliary" }).conversation_key).toBe(`aux-${before.conversation_key}`);
      return before.conversation_key;
    })));
    expect(keys[0]).not.toBe(keys[1]);
  });
  it("does not overwrite request fields or treat explicit cache controls as affinity strings", () => {
    expect(cachePolicyFields({ ...input, policy: { kind: "affinity-key", affinityField: "messages", isolationField: "__proto__" } })).toEqual({});
    for (const field of [
      "text", "prompt", "truncation", "background", "conversation", "previous_response_id",
      "service_tier", "safety_identifier", "seed", "modalities", "audio", "prediction",
      "verbosity", "frequency_penalty", "presence_penalty", "logit_bias", "logprobs", "top_logprobs",
    ]) {
      expect(cachePolicyFields({ ...input, policy: { kind: "affinity-key", affinityField: field, isolationField: field } }), field).toEqual({});
    }
    expect(cachePolicyFields({ ...input, policy: { kind: "explicit-breakpoint", affinityField: "cache_control" } })).toEqual({});
    expect(cachePolicyFields({ ...input, policy: { kind: "none-documented", affinityField: "cache_key" } })).toEqual({});
  });
  it.each(["disabled", "suppressed"] as const)("cannot inject cache hashes into %s reasoning controls", (state) => {
    const customProviders = getConfig().customProviders;
    const definition = {
      id: "cache-control-guard", displayName: "Cache control guard",
      baseUrl: "https://gateway.invalid/v1", defaultModel: "qwen3",
      profile: { reasoning: { controlDialect: "qwen-enable-thinking" as const } },
    };
    const providerId = definition.id as ProviderId;
    const wire = () => {
      const options = {
        providerId, model: definition.defaultModel, messages: input.messages, stream: true,
        reasoning: { enabled: state === "suppressed", effort: "high" as const },
      };
      const plan = compileRequestPlan({ ...options, provider: providerId });
      return {
        compiled: JSON.parse(chatCompletionsBodyFromPlan(plan)),
        direct: JSON.parse(buildChatBody({
          ...options,
          cacheFields: cachePolicyFields({
            provider: providerId, model: options.model, messages: options.messages, policy: plan.policy.cache,
          }),
        })),
      };
    };
    try {
      updateConfig({ customProviders: [definition] });
      if (state === "suppressed") markReasoningUnsupported(providerId, definition.defaultModel);
      const expected = wire();
      if (state === "disabled") expect(expected.compiled.enable_thinking).toBe(false);
      else expect(expected.compiled).not.toHaveProperty("enable_thinking");
      for (const field of [
        "reasoning", "reasoning_effort", "thinking", "enable_thinking", "chat_template_kwargs",
        "thinking_budget", "reasoning_budget", "preserve_thinking", "clear_thinking",
        "include_reasoning", "reasoning_content", "think", "thinkingConfig", "generationConfig",
        "thinkingBudget", "thinkingLevel", "includeThoughts", "budget_tokens", "effort",
      ]) {
        updateConfig({ customProviders: [{
          ...definition,
          profile: { ...definition.profile, cache: { kind: "affinity-key", affinityField: field, isolationField: field } },
        }] });
        expect(wire(), field).toEqual(expected);
      }
    } finally {
      clearReasoningUnsupported();
      updateConfig({ customProviders });
    }
  });
});
