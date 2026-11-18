import type { CatalogFacts } from "./catalog-facts.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS, type ProviderProfileLayer } from "./provider-profile.js";
import { sarvamOmitsEffort, sarvamReasoningEfforts, sarvamWireApi } from "./sarvam-models.js";
import type { StreamTerminalPolicy } from "./stream-terminal.js";

export const SARVAM_RESPONSES_TERMINAL: StreamTerminalPolicy = {
  proofs: ["response-completed", "response-incomplete"],
  naturalEofAccepted: false,
};

export function sarvamProviderLayer(): ProviderProfileLayer {
  const responses = sarvamWireApi() === "responses";
  const evidence = {
    source: "builtin",
    confidence: "high",
    detail: responses
      ? "https://docs.sarvam.ai/api-reference/responses/create"
      : "https://docs.sarvam.ai/api-reference/chat/chat-completions-v2",
  } as const;
  return {
    evidence,
    transport: {
      authType: "native",
      keyEnv: "SARVAM_API_KEY",
      baseUrlEnv: "SARVAM_BASE_URL",
      chatPath: responses ? "/responses" : "/chat/completions",
      modelsPath: "/models",
      systemPolicy: "single-leading",
    },
    capabilities: {
      tools: "supported",
      streamOptions: responses ? "unsupported" : "supported",
      structuredOutput: "supported",
    },
    reasoning: {
      control: { dialect: "openai-effort", status: "unknown", evidence },
      outputShapes: responses ? ["structured-details"] : ["reasoning-content"],
      replayScope: "tool-turn",
      finalTurnPreservation: "unsupported",
    },
    cache: {
      kind: "automatic-prefix",
      cacheAffectingFields: responses
        ? ["input", "tools", "tool_choice", "reasoning"]
        : ["messages", "tools", "tool_choice", "reasoning_effort", "x-session-affinity"],
    },
    usage: {
      cachedInput: [responses ? "usage.input_tokens_details.cached_tokens" : "usage.prompt_tokens_details.cached_tokens"],
      reasoningOutput: [responses ? "usage.output_tokens_details.reasoning_tokens" : "usage.completion_tokens_details.reasoning_tokens"],
    },
    terminal: responses
      ? SARVAM_RESPONSES_TERMINAL
      : { proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS, naturalEofAccepted: false },
  };
}

export function sarvamModelLayer(facts: CatalogFacts | undefined): ProviderProfileLayer | undefined {
  const reasoning = facts?.reasoning;
  if (!facts || !reasoning) return undefined;
  const evidence = { source: "catalog", confidence: "high" } as const;
  const efforts = sarvamReasoningEfforts(facts);
  return {
    evidence,
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: reasoning.supported === false || efforts?.length === 0 ? "unsupported" : "supported",
        evidence,
      },
      ...(efforts ? { acceptedEfforts: efforts } : {}),
      disableForm: efforts?.includes("none") && !sarvamOmitsEffort(facts.id, "none")
        ? "effort-none" : "omit-control",
    },
  };
}
