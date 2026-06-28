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
import { mantleProvider } from "./aws-mantle.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";

const MAX_RETRIES = 2;
// Wait at most this long before giving up on a provider and falling through.
const MAX_RETRY_WAIT_MS = 8_000;

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

function retryWaitMs(error: unknown, attempt: number): number {
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.ceil(error.retryAfterSeconds * 1000);
  }
  return (attempt + 1) * 2_000;
}

function summarizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Collapse newlines and excess whitespace; cap length so logs stay readable.
  const flattened = message.replace(/\s+/g, " ").trim();
  return flattened.length > 240 ? `${flattened.slice(0, 237)}...` : flattened;
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
    return [401, 403, 404, 413, 422, 429].includes(error.status ?? 0);
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
};

const fallbackOrder: ProviderId[] = [
  "nvidia",
  "groq",
  "gemini",
  "openrouter",
  "agentrouter",
  "kimchi",
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
  const fallbackEnabled = config.providerFallback && isDefaultModel;
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
      const model =
        providerId === requested
          ? (request.model ?? provider.defaultModel)
          : provider.defaultModel;
      return await provider.complete(
        { ...request, provider: providerId, model },
        auth,
      );
    } catch (error) {
      failures.push({ provider: providerId, message: summarizeProviderError(error) });
      if (shouldStopFallback(error)) {
        throw new Error(
          `No provider could complete the request.${formatFailures(failures)}`,
        );
      }
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
  const fallbackEnabled = config.providerFallback && isDefaultModel;
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
        if (request.signal?.aborted) throw error;
        if (isRateLimited(error)) {
          const wait = retryWaitMs(error, attempt);
          if (attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS) {
            emitStatus(
              `\n  ⏳ ${providerId} rate limited, retrying in ${Math.ceil(wait / 1000)}s...\n`,
            );
            await sleep(wait, request.signal);
            continue;
          }
          const suffix =
            wait > MAX_RETRY_WAIT_MS
              ? ` (~${Math.ceil(wait / 1000)}s)`
              : "";
          emitStatus(
            `\n  ⏳ ${providerId} rate limited${suffix}; staying on selected provider.\n`,
          );
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
