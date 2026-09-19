import type { CompletionRequest, CompletionResult } from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import { readJson, ingestModelCatalogEntries, ProviderError } from "./http.js";
import {
  CODEX_API_BASE_URL,
  CODEX_CLIENT_VERSION,
  codexRequestHeaders,
  decodeCodexKey,
  maybeRefreshCodexCredential,
  type CodexCredential,
} from "./codex-auth.js";
import { currentRequestPurpose } from "./request-purpose.js";
import { getProviderKeys, setProviderKeys } from "../store/keys.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "./cache-affinity.js";
import { currentSessionAffinity } from "./session-affinity.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  mapResponsesEffort,
  responsesReasoningSummary,
  responsesStream,
  type ResponsesBodyExtrasContext,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";

const baseUrl = CODEX_API_BASE_URL;

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      "Codex authentication required. Run `clai auth codex` (browser sign-in) or add a key with `clai set codex <token>`.",
    );
  }
  return auth.apiKey;
}

function credentialFor(auth: ProviderAuth) {
  const credential = decodeCodexKey(requireKey(auth));
  if (!credential) {
    throw new Error(
      "Codex credential is malformed. Run `clai auth codex` to sign in again.",
    );
  }
  return credential;
}

async function withCodexCredential<T>(
  auth: ProviderAuth,
  run: (credential: ReturnType<typeof credentialFor>) => Promise<T>,
): Promise<T> {
  const credential = credentialFor(auth);
  try {
    return await run(credential);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    const renewable =
      (status === 401 || status === 403) && currentRequestPurpose() === undefined;
    if (!renewable) throw error;
    const fresh = await maybeRefreshCodexCredential(auth.apiKey ?? "");
    if (!fresh || fresh === auth.apiKey) throw error;
    await replaceCodexKey(auth.apiKey ?? "", fresh).catch(() => undefined);
    const renewed = decodeCodexKey(fresh);
    if (!renewed) throw error;
    return run(renewed);
  }
}

async function replaceCodexKey(oldKey: string, newKey: string): Promise<void> {
  const multi = await getProviderKeys("codex");
  if (multi.source === "env") return;
  if (multi.keys.some((slot) => slot.value === newKey)) return;
  const values = multi.keys.map((slot) =>
    slot.value === oldKey ? newKey : slot.value,
  );
  const disabled = multi.keys
    .filter((slot) => slot.disabled === true)
    .map((slot) => (slot.value === oldKey ? newKey : slot.value));
  await setProviderKeys("codex", values, multi.activeIndex, disabled);
}

function settingsFor(credential: ReturnType<typeof credentialFor>) {
  return codexRequestHeaders(credential.accountId);
}

function codexCacheKey(context: ResponsesBodyExtrasContext): string {
  const affinity = currentSessionAffinity();
  const key = affinity
    ? sessionCacheAffinityKey(affinity)
    : cacheAffinityKey("codex", context.model, context.messages);
  return `${context.purpose === "auxiliary" ? "aux-" : ""}${key}`;
}

function codexConfigFor(credential: CodexCredential): ResponsesDialectConfig {
  return {
    baseUrl,
    providerId: "codex",
    displayName: "Codex",
    artifactDialect: "openai-compatible",
    terminalPolicy: META_STREAM_TERMINAL,
    omitSampling: true,
    maxTokensField: "omit",
    buildHeaders(auth, accept) {
      return {
        "content-type": "application/json",
        accept,
        ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
        ...codexRequestHeaders(credential.accountId),
      };
    },
    reasoningPayload(reasoning) {
      if (!reasoning?.enabled) return undefined;
      const effort = mapResponsesEffort(reasoning.effort);
      return { effort, summary: responsesReasoningSummary(effort) };
    },
    bodyExtras(context) {
      return {
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: codexCacheKey(context),
      };
    },
  };
}

function codexCatalogEntries(payload: unknown): readonly unknown[] {
  const container =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const list = Array.isArray(container?.models)
    ? (container.models as unknown[])
    : Array.isArray(container?.data)
      ? (container.data as unknown[])
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const slug = record.slug ?? record.id ?? record.name;
    if (typeof slug !== "string" || !slug) return entry;
    const visibility = record.visibility;
    return {
      ...record,
      id: slug,
      ...(visibility === "list" || visibility === undefined
        ? {}
        : { visibility }),
    };
  });
}

export const codexProvider: LlmProvider = {
  id: "codex",
  displayName: "ChatGPT (Codex)",
  reasoningStyle: "openai",
  defaultModel: defaultModels.codex,
  envVar: "CODEX_API_KEY",
  validateKey: (key: string) => decodeCodexKey(key) !== undefined,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const headers: Record<string, string> = {};
    if (auth.apiKey) {
      const credential = decodeCodexKey(auth.apiKey);
      if (credential) {
        Object.assign(headers, settingsFor(credential));
        headers["authorization"] = `Bearer ${credential.accessToken}`;
      }
    }
    const response = await fetch(
      `${baseUrl}/models?client_version=${CODEX_CLIENT_VERSION}`,
      { headers },
    );
    const payload = await readJson<unknown>(response);
    const models = ingestModelCatalogEntries("codex", codexCatalogEntries(payload));
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const credential = credentialFor(auth);
    const response = await fetch(
      `${baseUrl}/models?client_version=${CODEX_CLIENT_VERSION}`,
      {
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          ...settingsFor(credential),
        },
      },
    );
    if (!response.ok) {
      throw new ProviderError(
        `Codex authentication failed (HTTP ${response.status}). Run \`clai auth codex\` to sign in.`,
        response.status,
      );
    }
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.codex;
    return withCodexCredential(auth, async (credential) => {
      const config = codexConfigFor(credential);
      const streamRequest: CompletionRequest = {
        ...request,
        provider: "codex",
        model,
      };
      return responsesStream(
        config,
        streamRequest,
        { apiKey: credential.accessToken },
        () => {},
        model,
      );
    });
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.codex;
    return withCodexCredential(auth, async (credential) => {
      const config = codexConfigFor(credential);
      const streamRequest: CompletionRequest = {
        ...request,
        provider: "codex",
        model,
      };
      return responsesStream(
        config,
        streamRequest,
        { apiKey: credential.accessToken },
        onToken,
        model,
      );
    });
  },
};