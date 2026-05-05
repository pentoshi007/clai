import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { providerIds } from "../types.js";

export interface LlmProvider {
  id: ProviderId;
  displayName: string;
  defaultModel: string;
  envVar?: string | undefined;
  validateKey(key: string): boolean;
  ping(options: ProviderAuth): Promise<void>;
  complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult>;
}

export interface ProviderAuth {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export const providerAliases: Record<string, ProviderId> = {
  groq: "groq",
  gemini: "gemini",
  google: "gemini",
  openrouter: "openrouter",
  openai: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  ollama: "ollama",
  local: "ollama",
};

export const defaultModels: Record<ProviderId, string> = {
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.0-flash",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  ollama: "llama3.1:8b",
};

export const envVars: Record<ProviderId, string | undefined> = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  ollama: "OLLAMA_HOST",
};

export function normalizeProvider(value: string): ProviderId | undefined {
  return providerAliases[value.trim().toLowerCase()];
}

export function assertProvider(value: string): ProviderId {
  const provider = normalizeProvider(value);
  if (!provider) {
    throw new Error(
      `Unsupported provider "${value}". Supported providers: ${providerIds.join(", ")}`,
    );
  }
  return provider;
}

export function getDefaultModel(provider: ProviderId): string {
  return defaultModels[provider];
}

export function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return "••••";
  }
  const knownPrefix =
    ["gsk_", "AIza", "sk-or-", "sk-ant-", "sk-"].find((prefix) =>
      secret.startsWith(prefix),
    ) ?? "";
  const suffix = secret.slice(-4);
  return `${knownPrefix}••••••${suffix}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/gsk_[A-Za-z0-9_-]+/g, "gsk_••••••")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza••••••")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-••••••")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-••••••")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-••••••");
}
