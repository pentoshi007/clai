import type { CompletionRequest, CompletionResult } from "../types.js";
import type { ProviderAuth } from "./provider.js";
import { ProviderError } from "./http.js";
import { withReasoningObservation } from "./token-usage.js";
import type { ResponsesDialectConfig } from "./responses-config.js";
import {
  buildResponsesRequestBody,
  postResponses,
  readResponsesJson,
} from "./responses-http.js";
import {
  assembleCompletionResult,
  isOutputBudgetIncomplete,
  parseResponsesOutput,
  parseResponsesUsage,
  responsesReasoningArtifacts,
} from "./responses-parse.js";

export async function responsesComplete(
  config: ResponsesDialectConfig,
  request: CompletionRequest,
  auth: ProviderAuth,
  model: string,
  validate?: (data: unknown) => void,
): Promise<CompletionResult> {
  const body = buildResponsesRequestBody(config, request, model, false);
  const response = await postResponses(
    config,
    auth,
    body,
    request.signal ?? null,
    "application/json",
  );
  const data = await readResponsesJson(config, model, response);
  validate?.(data);
  const parsed = parseResponsesOutput(
    data as { output?: unknown; usage?: unknown },
  );
  const reasoningArtifacts = responsesReasoningArtifacts(
    config,
    model,
    parsed.reasoningItems,
    parsed.reasoningItemPositions,
  );
  const usage = withReasoningObservation(
    parsed.usage ?? parseResponsesUsage((data as Record<string, unknown>).usage),
    Boolean(parsed.reasoningSummary.trim()),
  );
  const outputBudgetIncomplete = isOutputBudgetIncomplete(
    data as Record<string, unknown>,
  );
  if (
    !outputBudgetIncomplete &&
    !parsed.text.trim() &&
    parsed.toolCalls.length === 0 &&
    !parsed.reasoningSummary.trim()
  ) {
    throw new ProviderError(
      `${config.displayName} returned no completion text (model=${model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`,
    );
  }
  return assembleCompletionResult({
    config,
    model,
    parsed,
    usage,
    reasoningArtifacts,
    outputBudgetIncomplete,
  });
}
