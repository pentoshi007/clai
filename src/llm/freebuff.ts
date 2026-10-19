import { randomUUID } from "node:crypto";
import type { CompletionRequest, CompletionResult } from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  ProviderError,
  toCompletionResult,
  type OpenAiCompatibleResult,
} from "./http.js";
import { FREEBUFF_API_BASE_URL, isFreebuffToken, validateFreebuffToken } from "./freebuff-auth.js";
import { freebuffAgentPreamble } from "./freebuff-agent-prompt.js";
import { fetchFreebuffModelIds, freebuffCatalogHandle, freebuffCatalogSnapshot, freebuffStaticModelIds } from "./freebuff-models.js";
import { freebuffDeviceHeaders } from "./freebuff-device-key.js";
import { freebuffSessionManager, type FreebuffAdmission } from "./freebuff-session.js";
import { finishFreebuffRun, startFreebuffRun } from "./freebuff-run.js";
import {
  freebuffActingUserHeaders,
  freebuffEnvHeaderValue,
  freebuffProviderRouting,
  freebuffUserAgent,
} from "./freebuff-wire.js";
import { currentSessionAffinity } from "./session-affinity.js";

const CHAT_BASE_URL = `${FREEBUFF_API_BASE_URL}/api/v1`;
const FALLBACK_CLIENT_ID = randomUUID();
const SESSION_ENDING_CODES = new Set(["session_superseded", "session_expired", "session_model_mismatch"]);
const FREEBUFF_RETRY_HINT =
  "The model may be busy or unavailable right now: send your message again to retry, or pick another model with /model.";

function freebuffDateLabel(): string {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function withFreebuffPreamble(messages: CompletionRequest["messages"]): CompletionRequest["messages"] {
  const preamble = freebuffAgentPreamble(freebuffDateLabel());
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) return [{ role: "system", content: preamble }, ...messages];
  return messages.map((message, index) =>
    index === systemIndex ? { ...message, content: `${preamble}\n\n${message.content}` } : message,
  );
}

function freebuffSessionEndedDetail(error: ProviderError): { code: string; message: string | undefined } | undefined {
  if (!error.body) return undefined;
  try {
    const parsed = JSON.parse(error.body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error !== "string" || !SESSION_ENDING_CODES.has(parsed.error)) return undefined;
    return { code: parsed.error, message: typeof parsed.message === "string" ? parsed.message : undefined };
  } catch {
    return undefined;
  }
}

async function endFreebuffSessionOnError(token: string, model: string, error: unknown): Promise<unknown> {
  if (!(error instanceof ProviderError)) return error;
  const ended = freebuffSessionEndedDetail(error);
  if (!ended) return error;
  freebuffSessionManager().discard(token, model);
  const detail = ended.message?.trim() || "This Freebuff session has ended. Start a new session to try again.";
  const suffix = ended.code === "session_superseded" && /refund/i.test(detail) ? ` ${FREEBUFF_RETRY_HINT}` : "";
  return new ProviderError(`Freebuff session ended (${ended.code}). ${detail}${suffix}`, error.status);
}

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
  const catalog = freebuffCatalogSnapshot(token);
  const chatModel = freebuffCatalogHandle(token, model) ?? model;
  const chatUrl = `${CHAT_BASE_URL}/chat/completions`;
  const options = {
    provider: "Freebuff",
    providerId: "freebuff" as const,
    baseUrl: CHAT_BASE_URL,
    apiKey: token,
    model: chatModel,
    messages: withFreebuffPreamble(request.messages),
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    headers: {
      "user-agent": freebuffUserAgent(),
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
      "x-freebuff-sse-gzip-recovery": "1",
      ...freebuffActingUserHeaders(),
      ...(catalog?.fetchId ? { "x-freebuff-catalog-fetch": catalog.fetchId } : {}),
    },
    ...(catalog
      ? {
          signingHeaders: (body: string) =>
            freebuffDeviceHeaders({
              token,
              method: "POST",
              url: chatUrl,
              body,
              ...(catalog.fetchId !== undefined ? { fetchId: catalog.fetchId } : {}),
            }),
        }
      : {}),
    bodyExtras: {
      codebuff_metadata: {
        freebuff_client_env: freebuffEnvHeaderValue(),
        ...admission.metadata,
        run_id: run.runId,
        client_id: run.clientId,
        cost_mode: "free",
      },
      provider: freebuffProviderRouting(chatModel),
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
    throw cancelled ? error : await endFreebuffSessionOnError(token, model, error);
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
