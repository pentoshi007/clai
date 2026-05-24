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
  stream?(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
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
  nvidia: "nvidia",
  nim: "nvidia",
  nvcf: "nvidia",
  agentrouter: "agentrouter",
  "agent-router": "agentrouter",
  router: "agentrouter",
  ollama: "ollama",
  local: "ollama",
};

export const defaultModels: Record<ProviderId, string> = {
  groq: "llama-3.3-70b-versatile",
  gemini: "gemini-2.0-flash",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "openai/gpt-oss-20b",
  agentrouter: "claude-haiku-4-5-20251001",
  ollama: "llama3.1:8b",
};

const retiredModelReplacements: Partial<Record<ProviderId, Record<string, string>>> = {
  groq: {
    "gemma2-9b-it": "llama-3.1-8b-instant",
    "moonshotai/kimi-k2-instruct": "openai/gpt-oss-120b",
    "deepseek-r1-distill-llama-70b": "llama-3.3-70b-versatile",
    "llama3-70b-8192": "llama-3.3-70b-versatile",
    "llama3-8b-8192": "llama-3.1-8b-instant",
    "meta-llama/llama-4-maverick-17b-128e-instruct":
      "meta-llama/llama-4-scout-17b-16e-instruct",
  },
  nvidia: {
    // Older default; redirect existing configs to the new openai/gpt-oss-20b
    // default so retired Nemotron entries don't surface 404s.
    "nvidia/llama-3.3-nemotron-super-49b-v1": defaultModels.nvidia,
  },
};

export const envVars: Record<ProviderId, string | undefined> = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  agentrouter: "AGENTROUTER_API_KEY",
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

export function sanitizeProviderModel(provider: ProviderId, model: string): string {
  const normalized = model.trim();
  const replacement =
    retiredModelReplacements[provider]?.[normalized.toLowerCase()];
  return replacement ?? normalized;
}

export function maskSecret(secret: string): string {
  // Show the first 4 characters and the last 3 characters with a fixed
  // dotted middle, so users can identify the right key at a glance
  // without leaking enough of it to be useful to a shoulder-surfer.
  if (secret.length <= 7) return "•".repeat(Math.max(secret.length, 4));
  return `${secret.slice(0, 4)}••••${secret.slice(-3)}`;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/gsk_[A-Za-z0-9_-]+/g, "gsk_••••••")
    .replace(/AIza[0-9A-Za-z_-]+/g, "AIza••••••")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-••••••")
    .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-••••••")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-••••••")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-••••••");
}
