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
  const thinkingEnabled = Boolean(request.thinking?.enabled);
  const reasoningArtifacts = thinkingEnabled
    ? responsesReasoningArtifacts(
        config,
        model,
        parsed.reasoningItems,
        parsed.reasoningItemPositions,
      )
    : undefined;
  const usage = withReasoningObservation(
    parsed.usage ??
      parseResponsesUsage((data as Record<string, unknown>).usage),
    thinkingEnabled && Boolean(parsed.reasoningSummary.trim()),
  );
  const outputBudgetIncomplete = isOutputBudgetIncomplete(
    data as Record<string, unknown>,
  );
  if (
    !outputBudgetIncomplete &&
    !parsed.text.trim() &&
    parsed.toolCalls.length === 0 &&
    !(thinkingEnabled && parsed.reasoningSummary.trim())
  ) {
    throw new ProviderError(
      `${config.displayName} returned no completion text (model=${model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`,
    );
  }
  const result = assembleCompletionResult({
    config,
    model,
    parsed,
    usage,
    reasoningArtifacts,
    outputBudgetIncomplete,
  });
  if (!thinkingEnabled) {
    const { reasoningBlock: _rb, reasoningArtifacts: _ra, ...rest } = result as unknown as Record<string, unknown>;
    return rest as unknown as CompletionResult;
  }
  return result;
}
