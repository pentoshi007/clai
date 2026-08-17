import { randomUUID } from "node:crypto";
import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  normalizeEndpointUrl,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  ProviderError,
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  streamIdleBudgets,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";

/**
 * Modal Endpoints (https://modal.com/docs/guide/endpoints) serve the OpenAI
 * Chat Completions API under `/v1` on a URL that belongs to the user's
 * workspace, e.g.
 *
 *   https://<workspace>--ep-kimi-k3-server.us-west.modal.direct/v1
 *
 * Two things make Modal different from every other OpenAI-compatible provider
 * already wired up here:
 *
 *  1. There is no bearer API key. Endpoints are authenticated by default with a
 *     *proxy token pair* sent as the `Modal-Key` (token id, `wk-…`) and
 *     `Modal-Secret` (token secret, `ws-…`) headers. We keep the OpenAI-shaped
 *     `Authorization: Bearer unused` header that the helpers add, exactly like
 *     Modal's own TypeScript quickstart (`apiKey: "unused"`).
 *  2. The base URL is per-user, so it is configuration (`modalBaseUrl`) rather
 *     than a constant — the same shape as the Ollama host.
 *
 * The token pair is stored as a single `"<id>:<secret>"` secret so it flows
 * through the existing keychain storage and multi-key rotation untouched.
 */

/** Modal ignores the bearer header; mirrors `apiKey: "unused"` in their docs. */
const UNUSED_BEARER = "unused";

const SETUP_HINT =
  'set it with `clai set modal --url https://<workspace>--ep-<endpoint>.<region>.modal.direct` or the MODAL_BASE_URL env var';

export interface ModalToken {
  id: string;
  secret: string;
}

/**
 * Accept the `"<token-id>:<token-secret>"` pair clai stores as one secret.
 * Deliberately prefix-agnostic (workspaces created before the `wk-`/`ws-`
 * prefixes, or RBAC-scoped tokens, still work) but strict about the shape so a
 * half-pasted credential fails loudly at `clai set` instead of at request time.
 */
export function parseModalToken(raw: string | undefined): ModalToken | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return undefined;
  const id = trimmed.slice(0, separator).trim();
  const secret = trimmed.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9_.-]{6,}$/.test(id)) return undefined;
  if (!/^[A-Za-z0-9_.-]{6,}$/.test(secret)) return undefined;
  return { id, secret };
}



/**
 * Sticky sessions: Modal routes requests carrying the same `Modal-Session-ID`
 * to the same container, which keeps the prompt cache warm across a
 * conversation. One id per clai run unless the user pins their own.
 */
let generatedSessionId: string | undefined;

export function modalSessionId(): string {
  const configured = process.env.MODAL_SESSION_ID?.trim();
  if (configured) return configured;
  generatedSessionId ??= `clai-${randomUUID()}`;
  return generatedSessionId;
}

/** Reset the generated sticky-session id (new chat / tests). */
export function resetModalSessionId(): void {
  generatedSessionId = undefined;
}

function resolveBaseUrl(auth: ProviderAuth): string {
  const base = normalizeEndpointUrl(auth.baseUrl ?? "");
  if (!base) {
    throw new ProviderError(
      `Modal endpoint URL is not configured — ${SETUP_HINT}.`,
    );
  }
  return base;
}

function resolveToken(auth: ProviderAuth): ModalToken {
  const token = parseModalToken(auth.apiKey);
  if (!token) {
    throw new ProviderError(
      "Modal proxy token is missing or malformed. Expected `<token-id>:<token-secret>` " +
        "(create one with `modal workspace proxy-tokens create`, then " +
        "`clai set modal wk-…:ws-…`).",
    );
  }
  return token;
}

function modalHeaders(token: ModalToken): Record<string, string> {
  return {
    "Modal-Key": token.id,
    "Modal-Secret": token.secret,
    "Modal-Session-ID": modalSessionId(),
  };
}

let cachedModels: { baseUrl: string; models: string[]; fetchedAt: number } | undefined;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min: endpoints change when redeployed

export const modalProvider: LlmProvider = {
  id: "modal",
  reasoningStyle: "modal",
  displayName: "Modal",
  defaultModel: defaultModels.modal,
  envVar: "MODAL_PROXY_TOKEN_ID",
  validateKey: (key: string) => parseModalToken(key) !== undefined,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const token = parseModalToken(auth.apiKey);
    const baseUrl = normalizeEndpointUrl(auth.baseUrl ?? "");
    if (!token || !baseUrl) return [];
    const now = Date.now();
    if (
      cachedModels &&
      cachedModels.baseUrl === baseUrl &&
      now - cachedModels.fetchedAt < CACHE_TTL_MS
    ) {
      return cachedModels.models;
    }
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: modalHeaders(token),
      });
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      const models = ingestOpenAiModelCatalog("modal", data);
      if (models.length > 0) {
        cachedModels = { baseUrl, models, fetchedAt: now };
      }
      return models;
    } catch {
      // Falls back to the static catalog in the pickers.
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const token = resolveToken(auth);
    const baseUrl = resolveBaseUrl(auth);
    await openAiCompatiblePing(baseUrl, UNUSED_BEARER, modalHeaders(token));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const token = resolveToken(auth);
    const baseUrl = resolveBaseUrl(auth);
    const model = request.model ?? defaultModels.modal;
    const payload = await openAiCompatibleComplete({
      provider: "Modal",
      providerId: "modal",
      baseUrl,
      apiKey: UNUSED_BEARER,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers: modalHeaders(token),
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "modal",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("modal", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const token = resolveToken(auth);
    const baseUrl = resolveBaseUrl(auth);
    const model = request.model ?? defaultModels.modal;
    const payload = await openAiCompatibleStream({
      provider: "Modal",
      providerId: "modal",
      baseUrl,
      apiKey: UNUSED_BEARER,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers: modalHeaders(token),
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "modal",
      // Endpoints scale to zero, so the first request after idle pays a cold
      // start. Give the initial byte a generous budget before declaring a stall.
      initialIdleTimeoutMs: Math.max(
        240_000,
        streamIdleBudgets(Boolean(request.thinking?.enabled)).idleTimeoutMs,
      ),
      // The mid-stream budget must outlast a whole buffered tool call: the
      // tool-call parser in front of these endpoints emits nothing while it
      // accumulates a large `arguments` string, so a model writing one big file
      // is silent on the wire for the full generation. The old 90s budget
      // aborted those healthy streams at firstToken+90s and retried three times.
      idleTimeoutMs: Math.max(
        300_000,
        streamIdleBudgets(Boolean(request.thinking?.enabled)).idleTimeoutMs,
      ),
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("modal", model, payload);
  },
};
