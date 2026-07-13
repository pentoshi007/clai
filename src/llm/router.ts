import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { getConfig, providerCategory } from "../store/config.js";
import { getProviderSecret } from "../store/keys.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import { ProviderError } from "./http.js";
import { nvidiaProvider } from "./nvidia.js";
import { agentrouterProvider } from "./agentrouter.js";
import { kimchiProvider } from "./kimchi.js";
import { bynaraProvider } from "./bynara.js";
import { mantleProvider } from "./aws-mantle.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";

const MAX_RETRIES = 6;
// Wait at most this long overall per attempt (up to 2 minutes total wait budget).
const MAX_RETRY_WAIT_MS = 120_000;

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    let cleanup = (): void => {};
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 429;
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const msg = message.toLowerCase();
  return (
    msg.includes("socket connection was closed unexpectedly") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("unexpected end of file") ||
    msg.includes("premature close")
  );
}

function isRetriableError(error: unknown): boolean {
  if (isRateLimited(error)) return true;
  if (error instanceof ProviderError) {
    const status = error.status ?? 0;
    if (status >= 500 && status <= 504) {
      return true;
    }
  }
  return isTransientNetworkError(error);
}

function retryWaitMs(error: unknown, attempt: number): number {
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.ceil(error.retryAfterSeconds * 1000);
  }
  // Exponential backoff: 2s, 6s, 18s, 54s, etc.
  return Math.pow(3, attempt) * 2_000;
}

function networkRetryWaitMs(attempt: number): number {
  return Math.pow(2, attempt) * 1_000;
}

function summarizeProviderError(error: unknown): string {
  if (error instanceof ProviderError && error.status === 429) {
    return "Model is rate limited (429). Try another provider/model or switch to a paid plan.";
  }
  const message = error instanceof Error ? error.message : String(error);
  // Collapse newlines and excess whitespace. Keep the full message in the
  // main chat so users can see the provider's actual error details.
  return message.replace(/\s+/g, " ").trim();
}

interface ProviderFailure {
  provider: ProviderId;
  message: string;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatFailures(failures: ProviderFailure[]): string {
  if (failures.length === 0) return "";
  const rows = failures.map((failure) =>
    `${failure.provider.padEnd(12)} ${escapeTableCell(failure.message)}`,
  );
  return `\n\nProvider      Error\n------------  -----\n${rows.join("\n")}`;
}

function shouldStopFallback(error: unknown): boolean {
  if (error instanceof ProviderError) {
    // A 413 can be a free-tier input/TPM ceiling rather than an invalid
    // request. Let configured fallback providers try a smaller/roomier
    // request path instead of treating it as a credential or body error.
    return [401, 403, 404, 422, 429].includes(error.status ?? 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no completion text|response was empty|empty response|returned no text/i.test(message);
}

export const providers: Record<ProviderId, LlmProvider> = {
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  nvidia: nvidiaProvider,
  agentrouter: agentrouterProvider,
  kimchi: kimchiProvider,
  "aws-mantle": mantleProvider,
  ollama: ollamaProvider,
  bynara: bynaraProvider,
};

const fallbackOrder: ProviderId[] = [
  "nvidia",
  "groq",
  "gemini",
  "openrouter",
  "agentrouter",
  "kimchi",
  "bynara",
  "openai",
  "anthropic",
  "aws-mantle",
  "ollama",
];

/**
 * Build the fallback chain, optionally filtering paid-cloud providers when
 * `freeOnly` is enabled. The user's explicitly requested provider is always
 * tried first regardless of category — flipping freeOnly never strands an
 * explicit `clai --provider openai` request.
 */
export function buildFallbackChain(
  requested: ProviderId,
  freeOnly: boolean,
  enabled = false,
): ProviderId[] {
  if (!enabled) return [requested];
  const filtered = freeOnly
    ? fallbackOrder.filter(
        (provider) =>
          provider === requested || providerCategory[provider] !== "paid-cloud",
      )
    : fallbackOrder;
  return [requested, ...filtered.filter((provider) => provider !== requested)];
}

export function getProvider(provider: ProviderId): LlmProvider {
  return providers[provider];
}

export async function providerAuth(
  provider: ProviderId,
): Promise<ProviderAuth> {
  const secret = await getProviderSecret(provider);
  if (provider === "ollama") {
    return { baseUrl: secret.value };
  }
  return { apiKey: secret.value };
}

export async function completeWithProvider(
  request: CompletionRequest,
): Promise<CompletionResult> {
  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = providers[requested];
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    config.providerFallback && (isDefaultModel || request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
  );
  const failures: ProviderFailure[] = [];

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const auth = await providerAuth(providerId);
    const hasAuth =
      providerId === "ollama" ? Boolean(auth.baseUrl) : Boolean(auth.apiKey);
    if (!hasAuth) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const model =
            providerId === requested
              ? (request.model ?? provider.defaultModel)
              : provider.defaultModel;
          return await provider.complete(
            { ...request, provider: providerId, model },
            auth,
          );
        } catch (error) {
          if (isRetriableError(error)) {
            const wait = isRateLimited(error)
              ? retryWaitMs(error, attempt)
              : networkRetryWaitMs(attempt);
            if (attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS) {
              await sleep(wait, request.signal);
              continue;
            }
            failures.push({ provider: providerId, message: summarizeProviderError(error) });
            throw new Error(
              `No provider could complete the request.${formatFailures(failures)}`,
            );
          }
          failures.push({ provider: providerId, message: summarizeProviderError(error) });
          if (shouldStopFallback(error)) {
            throw new Error(
              `No provider could complete the request.${formatFailures(failures)}`,
            );
          }
          break;
        }
      }
    } catch (err) {
      failures.push({ provider: providerId, message: summarizeProviderError(err) });
    }
  }

  throw new Error(
    `No provider could complete the request.${formatFailures(failures)}`,
  );
}

export async function streamWithProvider(
  request: CompletionRequest,
  onToken: (token: string) => void,
  onStatus?: (message: string) => void,
): Promise<CompletionResult> {
  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const providerImpl = providers[requested];
  const isDefaultModel = !request.model || request.model === providerImpl.defaultModel;
  const fallbackEnabled =
    config.providerFallback && (isDefaultModel || request.allowModelFallback === true);
  const order = buildFallbackChain(
    requested,
    config.freeOnly,
    fallbackEnabled,
  );
  const failures: ProviderFailure[] = [];
  const emitStatus = onStatus ?? ((message) => onToken(message));

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const auth = await providerAuth(providerId);
    const hasAuth =
      providerId === "ollama" ? Boolean(auth.baseUrl) : Boolean(auth.apiKey);
    if (!hasAuth) {
      failures.push({ provider: providerId, message: "no API key configured" });
      continue;
    }

    const model =
      providerId === requested
        ? (request.model ?? provider.defaultModel)
        : provider.defaultModel;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        request.signal?.throwIfAborted();
        if (provider.stream) {
          return await provider.stream(
            { ...request, provider: providerId, model },
            auth,
            onToken,
          );
        }
        const result = await provider.complete(
          { ...request, provider: providerId, model },
          auth,
        );
        onToken(result.text);
        return result;
      } catch (error) {
        if (isRetriableError(error)) {
          const wait = isRateLimited(error)
            ? retryWaitMs(error, attempt)
            : networkRetryWaitMs(attempt);
          if (attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS) {
            const reason = isRateLimited(error)
              ? "rate limited"
              : error instanceof ProviderError && error.status
                ? `server error (${error.status})`
                : "connection glitch";
            emitStatus(
              `\n  ⏳ ${providerId} ${reason}, retrying in ${Math.ceil(wait / 1000)}s...\n`,
            );
            await sleep(wait, request.signal);
            continue;
          }
          if (isRateLimited(error)) {
            const suffix =
              wait > MAX_RETRY_WAIT_MS
                ? ` (~${Math.ceil(wait / 1000)}s)`
                : "";
            emitStatus(
              `\n  ⏳ ${providerId} rate limited${suffix}; staying on selected provider.\n`,
            );
          }
          failures.push({ provider: providerId, message: summarizeProviderError(error) });
          throw new Error(
            `No provider could stream the request.${formatFailures(failures)}`,
          );
        }
        failures.push({ provider: providerId, message: summarizeProviderError(error) });
        if (shouldStopFallback(error)) {
          throw new Error(
            `No provider could stream the request.${formatFailures(failures)}`,
          );
        }
        break;
      }
    }
  }

  throw new Error(
    `No provider could stream the request.${formatFailures(failures)}`,
  );
}

export async function pingProvider(
  providerId: ProviderId,
  secretOverride?: string,
): Promise<void> {
  const provider = providers[providerId];
  const auth =
    providerId === "ollama"
      ? { baseUrl: secretOverride ?? (await providerAuth(providerId)).baseUrl }
      : { apiKey: secretOverride ?? (await providerAuth(providerId)).apiKey };
  await provider.ping(auth);
}
