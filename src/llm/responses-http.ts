import type { CompletionRequest } from "../types.js";
import type { ProviderAuth } from "./provider.js";
import { ProviderError, readJson } from "./http.js";
import { generationFetch } from "./operation-usage.js";
import { isOperationPolicyError } from "./operation-ledger.js";
import type {
  ResponsesAccept,
  ResponsesDialectConfig,
} from "./responses-config.js";
import { buildResponsesBody } from "./responses-request.js";

export function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Stream aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const succeed = (value: ReadableStreamReadResult<Uint8Array>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      fail(signal.reason ?? new Error("Stream aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void reader.read().then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export const PRIVATE_REASONING_NOTE_PREFIX = "Reasoning is private on";

export function responsesPrivateReasoningNote(
  config: ResponsesDialectConfig,
  request: CompletionRequest,
  reasoningTokens: number,
): string {
  const payload = config.reasoningPayload(request.thinking) as
    Record<string, unknown> | undefined;
  const effort = payload ? (payload.effort as string | undefined) : undefined;
  const effortText = effort ? ` at ${effort} effort` : "";
  return `${PRIVATE_REASONING_NOTE_PREFIX} ${config.displayName}: the model reasoned${effortText} and used ${reasoningTokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
}

export async function postResponses(
  config: ResponsesDialectConfig,
  auth: ProviderAuth,
  body: string,
  signal: AbortSignal | null,
  accept: ResponsesAccept,
): Promise<Response> {
  try {
    return await generationFetch(`${config.baseUrl}/responses`, {
      method: "POST",
      signal,
      headers: config.buildHeaders(auth, accept),
      body,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as unknown as RequestInit);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (isOperationPolicyError(error)) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new ProviderError(
      `${config.displayName} request could not be sent (${msg}). Check connectivity to ${config.baseUrl}.`,
    );
  }
}

export async function readResponsesJson(
  config: ResponsesDialectConfig,
  model: string,
  response: Response,
  signal?: AbortSignal,
): Promise<{
  output?: unknown;
  usage?: unknown;
  id?: string;
  error?: unknown;
}> {
  try {
    return await readJson(response, signal);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(
        `${config.displayName} (model=${model}): ${error.message}`,
        error.status,
        error.body,
        error.retryAfterSeconds,
      );
    }
    throw error;
  }
}

export function buildResponsesRequestBody(
  config: ResponsesDialectConfig,
  request: CompletionRequest,
  model: string,
  stream: boolean,
): string {
  return buildResponsesBody(config, {
    model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    stream,
    reasoning: request.thinking,
    toolChoice: request.toolChoice,
    tools: request.tools,
    parallelToolCalls: request.parallelToolCalls,
    purpose: request.purpose,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
  });
}
