import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { providerIds } from "../types.js";
import type { ReasoningStyle } from "./http.js";
import { providerInfo } from "./provider-info-text.js";
import {
  defaultModels,
  envVars,
  providerAliases,
  retiredModelReplacements,
} from "./provider-identity.js";
export { defaultModels, envVars, providerAliases };
export { providerInfo };

export interface LlmProvider {
  id: ProviderId;
  displayName: string;
  defaultModel: string;
  reasoningStyle?: ReasoningStyle | undefined;
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
  listModels?(auth: ProviderAuth): Promise<string[]>;
}

export interface ProviderAuth {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

export function getEnvVar(provider: ProviderId): string | undefined {
  if (envVars[provider]) return envVars[provider];
  return envVarResolver?.(provider);
}

let envVarResolver: ((provider: ProviderId) => string | undefined) | undefined;

export function setEnvVarResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  envVarResolver = resolver;
}

export function normalizeProvider(value: string): ProviderId | undefined {
  const alias = providerAliases[value.trim().toLowerCase()];
  if (alias) return alias;
  const lower = value.trim().toLowerCase();
  if (customProviderResolver?.(lower)) return lower as ProviderId;
  return undefined;
}

export function assertProvider(value: string): ProviderId {
  const provider = normalizeProvider(value);
  if (!provider) {
    throw new Error(
      `Unsupported provider "${value}". Supported providers: ${providerIds.join(", ")}${customProviderResolver ? " (plus any custom providers you added)" : ""}`,
    );
  }
  return provider;
}

export function getDefaultModel(provider: ProviderId): string {
  if (defaultModels[provider]) return defaultModels[provider];
  return customDefaultModelResolver?.(provider) ?? "";
}

let customProviderResolver: ((id: string) => boolean) | undefined;

export function setCustomProviderResolver(
  resolver: ((id: string) => boolean) | undefined,
): void {
  customProviderResolver = resolver;
}

export function sanitizeProviderModel(
  provider: ProviderId,
  model: string,
): string {
  const normalized = model.trim();
  const replacement =
    retiredModelReplacements[provider]?.[normalized.toLowerCase()];
  return replacement ?? normalized;
}

export function normalizeEndpointUrl(url: string): string {
  let value = url.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "");
  value = value.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  if (!/\/v\d+$/i.test(value)) value = `${value}/v1`;
  return value;
}

export function maskSecret(secret: string): string {
  const n = secret.length;
  if (n < 8) return "••••••••";
  return secret.slice(0, 4) + "••••" + secret.slice(-4);
}

export function maskSecretTail(secret: string): string {
  const n = secret.length;
  if (n < 4) return "••••";
  return `…${secret.slice(-4)}`;
}

export function redactSecrets(value: string): string {
  return (
    value
      .replace(/gsk_[A-Za-z0-9_-]+/g, "gsk_••••••")
      .replace(/AIza[0-9A-Za-z_-]+/g, "AIza••••••")
      .replace(/AQ\.[A-Za-z0-9_-]+/g, "AQ.••••••")
      .replace(/sk-[A-Za-z0-9._-]+/g, "sk-••••••")
      .replace(/sk-or-[A-Za-z0-9_-]+/g, "sk-or-••••••")
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-••••••")
      .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-••••••")
      .replace(/wk-[A-Za-z0-9_-]{16,}/g, "wk-••••••")
      .replace(/ws-[A-Za-z0-9_-]{16,}/g, "ws-••••••")
  );
}

export function getProviderInfoText(provider: string): string {
  const known = providerInfo[provider.toLowerCase()];
  if (known) return known;
  const custom = customProviderInfoResolver?.(provider);
  if (custom) return custom;
  return "no info available";
}

let customProviderInfoResolver:
  ((provider: string) => string | undefined) | undefined;

export function setCustomProviderInfoResolver(
  resolver: ((provider: string) => string | undefined) | undefined,
): void {
  customProviderInfoResolver = resolver;
}

let customDefaultModelResolver:
  ((provider: ProviderId) => string | undefined) | undefined;

export function setCustomDefaultModelResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  customDefaultModelResolver = resolver;
}
