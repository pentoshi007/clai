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
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";
import { openrouterProvider } from "./openrouter.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";

const MAX_RETRIES = 2;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 429;
}

export const providers: Record<ProviderId, LlmProvider> = {
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider,
};

const fallbackOrder: ProviderId[] = [
  "groq",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
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
      failures.push(
        `${providerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `No provider could complete the request. ${failures.join(" | ")}`,
  );
}

export async function streamWithProvider(
  request: CompletionRequest,
  onToken: (token: string) => void,
): Promise<CompletionResult> {
  const config = getConfig();
  const requested = request.provider ?? config.defaultProvider;
  const order = [
    requested,
    ...fallbackOrder.filter((provider) => provider !== requested),
  ];
  const failures: string[] = [];

  for (const providerId of order) {
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
        if (isRateLimited(error) && attempt < MAX_RETRIES) {
          const wait = (attempt + 1) * 2_000;
          onToken(`\n  ⏳ Rate limited, retrying in ${wait / 1000}s...\n`);
          await sleep(wait);
          continue;
        }
        failures.push(
          `${providerId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
  }

  throw new Error(
    `No provider could stream the request. ${failures.join(" | ")}`,
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
