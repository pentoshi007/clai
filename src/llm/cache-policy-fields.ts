import type { ChatMessage, ProviderId } from "../types.js";
import type { CachePolicySpec } from "./provider-profile.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "./cache-affinity.js";
import { currentSessionAffinity } from "./session-affinity.js";

const reserved = new Set([
  "__proto__", "constructor", "prototype", "model", "messages", "input",
  "instructions", "tools", "tool_choice", "parallel_tool_calls", "stream",
  "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens",
  "max_output_tokens", "reasoning", "reasoning_effort", "thinking", "store", "include",
  "cache_control", "response_format", "stop", "n", "user", "metadata",
  "text", "prompt", "truncation", "background", "conversation",
  "previous_response_id", "service_tier", "safety_identifier", "seed",
  "modalities", "audio", "prediction", "verbosity", "frequency_penalty",
  "presence_penalty", "logit_bias", "logprobs", "top_logprobs",
  "enable_thinking", "chat_template_kwargs", "thinking_budget", "reasoning_budget",
  "preserve_thinking", "clear_thinking", "include_reasoning", "reasoning_content",
  "think", "thinkingConfig", "generationConfig", "thinkingBudget", "thinkingLevel",
  "includeThoughts", "budget_tokens", "effort",
]);

export function cachePolicyFields(input: {
  provider: ProviderId;
  model: string;
  messages: readonly ChatMessage[];
  policy: Pick<CachePolicySpec, "kind" | "affinityField" | "isolationField">;
  purpose?: string | undefined;
}): Record<string, string> {
  if (input.policy.kind !== "affinity-key" && input.policy.kind !== "automatic-prefix") return {};
  const fields = [input.policy.affinityField, input.policy.isolationField]
    .filter((field): field is string => Boolean(
      field && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) && !reserved.has(field),
    ));
  if (fields.length === 0) return {};
  const session = currentSessionAffinity();
  const key = `${input.purpose === "auxiliary" ? "aux-" : ""}${session
    ? sessionCacheAffinityKey(session)
    : cacheAffinityKey(input.provider, input.model, input.messages)}`;
  return Object.fromEntries(fields.map((field) => [field, key]));
}
