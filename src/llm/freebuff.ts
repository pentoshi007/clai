import { randomUUID } from "node:crypto";
import type { CompletionRequest, CompletionResult } from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  toCompletionResult,
  type OpenAiCompatibleResult,
} from "./http.js";
import { FREEBUFF_API_BASE_URL, isFreebuffToken, validateFreebuffToken } from "./freebuff-auth.js";
import { fetchFreebuffModelIds, freebuffStaticModelIds } from "./freebuff-models.js";
import { freebuffSessionManager, type FreebuffAdmission } from "./freebuff-session.js";
import { finishFreebuffRun, startFreebuffRun } from "./freebuff-run.js";
import { freebuffProviderRouting, freebuffUserAgent } from "./freebuff-wire.js";
import { currentSessionAffinity } from "./session-affinity.js";

const CHAT_BASE_URL = `${FREEBUFF_API_BASE_URL}/api/v1`;
const FALLBACK_CLIENT_ID = randomUUID();

function requireKey(auth: ProviderAuth): string {
  const token = auth.apiKey?.trim();
  if (!isFreebuffToken(token)) {
    throw new Error(
      "Freebuff authentication required. Run `clai auth freebuff` to sign in (browser or headless), or set FREEBUFF_API_KEY.",
    );
  }
  return token;
}

async function generate(
  request: CompletionRequest,
  auth: ProviderAuth,
  onToken?: (token: string) => void,
): Promise<CompletionResult> {
  const token = requireKey(auth);
  const model = request.model ?? defaultModels.freebuff;
  return freebuffSessionManager().withAdmission(token, model, request.signal,
    (admission) => generateAdmitted(request, token, model, admission, onToken));
}

async function generateAdmitted(
  request: CompletionRequest,
  token: string,
  model: string,
  admission: FreebuffAdmission,
  onToken?: (token: string) => void,
): Promise<CompletionResult> {
  request.signal?.throwIfAborted();
  const run = await startFreebuffRun(token, model, {
    signal: request.signal,
    clientId: currentSessionAffinity() ?? FALLBACK_CLIENT_ID,
  });
  const options = {
    provider: "Freebuff",
    providerId: "freebuff" as const,
    baseUrl: CHAT_BASE_URL,
    apiKey: token,
    model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    headers: { "user-agent": freebuffUserAgent() },
    bodyExtras: {
      codebuff_metadata: { run_id: run.runId, client_id: run.clientId, ...admission.metadata },
      provider: freebuffProviderRouting(model),
    },
    signal: request.signal,
    reasoning: request.thinking,
    reasoningStyle: "openrouter" as const,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
  };
  let payload: OpenAiCompatibleResult;
  try {
    payload = onToken
      ? await openAiCompatibleStream({
          ...options,
          includeStreamUsage: false,
          onToken,
          onToolCallDelta: request.onToolCallDelta,
          onStreamEvent: request.onStreamEvent,
        })
      : await openAiCompatibleComplete(options);
  } catch (error) {
    const cancelled = request.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    await finishFreebuffRun(token, run, cancelled ? "cancelled" : "failed", 0, {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await finishFreebuffRun(token, run, "completed", 1);
  return toCompletionResult("freebuff", model, payload);
}

export const freebuffProvider: LlmProvider = {
  id: "freebuff",
  displayName: "Freebuff",
  reasoningStyle: "openrouter",
  defaultModel: defaultModels.freebuff,
  envVar: "FREEBUFF_API_KEY",
  validateKey: (key: string) => isFreebuffToken(key.trim()),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) return freebuffStaticModelIds();
    return fetchFreebuffModelIds(requireKey(auth));
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await validateFreebuffToken(requireKey(auth));
  },
  complete: (request, auth) => generate(request, auth),
  stream: (request, auth, onToken) => generate(request, auth, onToken),
};
