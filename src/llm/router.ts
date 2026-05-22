import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { getConfig } from "../store/config.js";
import { getProviderSecret } from "../store/keys.js";
import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { groqProvider } from "./groq.js";
import { ProviderError } from "./http.js";
import { nvidiaProvider } from "./nvidia.js";
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

function formatFailures(failures: string[]): string {
  return failures.map((failure) => `\n  • ${failure}`).join("");
}

export const providers: Record<ProviderId, LlmProvider> = {
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  nvidia: nvidiaProvider,
  ollama: ollamaProvider,
};

const fallbackOrder: ProviderId[] = [
  "groq",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "nvidia",
  "ollama",
];

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
  const order = [
    requested,
    ...fallbackOrder.filter((provider) => provider !== requested),
  ];
  const failures: string[] = [];

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const auth = await providerAuth(providerId);
    const hasAuth =
      providerId === "ollama" ? Boolean(auth.baseUrl) : Boolean(auth.apiKey);
    if (!hasAuth) {
      failures.push(`${providerId}: no API key configured`);
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
      failures.push(`${providerId}: ${summarizeProviderError(error)}`);
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
  const order = [
    requested,
    ...fallbackOrder.filter((provider) => provider !== requested),
  ];
  const failures: string[] = [];
  const emitStatus = onStatus ?? ((message) => onToken(message));

  for (const providerId of order) {
    request.signal?.throwIfAborted();
    const provider = providers[providerId];
    const auth = await providerAuth(providerId);
    const hasAuth =
      providerId === "ollama" ? Boolean(auth.baseUrl) : Boolean(auth.apiKey);
    if (!hasAuth) {
      failures.push(`${providerId}: no API key configured`);
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
        if (isRateLimited(error) && attempt < MAX_RETRIES) {
          const wait = retryWaitMs(error, attempt);
          if (wait > MAX_RETRY_WAIT_MS) {
            // Long wait — skip to next provider rather than blocking the user.
            emitStatus(
              `\n  ⏭  ${providerId} rate limited (~${Math.ceil(wait / 1000)}s); trying next provider...\n`,
            );
            failures.push(`${providerId}: ${summarizeProviderError(error)}`);
            break;
          }
          emitStatus(
            `\n  ⏳ ${providerId} rate limited, retrying in ${Math.ceil(wait / 1000)}s...\n`,
          );
          await sleep(wait, request.signal);
          continue;
        }
        failures.push(`${providerId}: ${summarizeProviderError(error)}`);
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
