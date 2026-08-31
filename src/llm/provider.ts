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

/** Resolve the env var for any provider, including user-defined custom ones. */
export function getEnvVar(provider: ProviderId): string | undefined {
  if (envVars[provider]) return envVars[provider];
  return envVarResolver?.(provider);
}

/** Injected resolver for custom-provider env vars (avoids a static import cycle). */
let envVarResolver: ((provider: ProviderId) => string | undefined) | undefined;

export function setEnvVarResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  envVarResolver = resolver;
}

export function normalizeProvider(value: string): ProviderId | undefined {
  const alias = providerAliases[value.trim().toLowerCase()];
  if (alias) return alias;
  // Custom (user-defined) providers: the id is its own alias. The resolver is
  // injected by `store/config.ts` at bootstrap to avoid a static import cycle
  // (config.ts imports defaultModels from this module).
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
  // Built-ins read from the static map; custom providers fall back to the
  // injected resolver (wired from store/config.js) so /keys shows their model.
  if (defaultModels[provider]) return defaultModels[provider];
  return customDefaultModelResolver?.(provider) ?? "";
}

/**
 * Inject the custom-provider id resolver (called once at bootstrap from
 * `store/config.ts`). Returns `true` when `id` matches a user-defined custom
 * provider. Kept here (rather than a static import) to avoid a config ↔
 * provider import cycle.
 */
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

/**
 * Normalize a user-supplied OpenAI-compatible base URL so the HTTP helpers can
 * append `/chat/completions` to it. Idempotent, and tolerant of the three
 * things people actually paste: a bare host, a trailing slash, or a full
 * endpoint path.
 *
 *   x--ep-y.modal.direct                  → https://x--ep-y.modal.direct/v1
 *   https://x--ep-y.modal.direct/v1/      → https://x--ep-y.modal.direct/v1
 *   https://host/v1/chat/completions      → https://host/v1
 */
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
  // Show first 4 and last 4 characters with a fixed-width •••• separator.
  // Output is always 12 chars for keys >= 8, keeping tables compact.
  const n = secret.length;
  if (n < 8) return "••••••••";
  return secret.slice(0, 4) + "••••" + secret.slice(-4);
}

/** Short tail for toast/status lines (`…ab12`). Never exposes the full secret. */
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
      // Modal proxy tokens: id `wk-…`, secret `ws-…`. Require a long tail so
      // ordinary words (`ws-connection`) are never mangled.
      .replace(/wk-[A-Za-z0-9_-]{16,}/g, "wk-••••••")
      .replace(/ws-[A-Za-z0-9_-]{16,}/g, "ws-••••••")
  );
}

export function getProviderInfoText(provider: string): string {
  const known = providerInfo[provider.toLowerCase()];
  if (known) return known;
  // Custom (user-defined) providers: generate a basic info page from the
  // stored definition so /info <custom-provider> is still useful.
  const custom = customProviderInfoResolver?.(provider);
  if (custom) return custom;
  return "no info available";
}

/** Injected resolver that builds an info page for a custom provider id. */
let customProviderInfoResolver:
  ((provider: string) => string | undefined) | undefined;

export function setCustomProviderInfoResolver(
  resolver: ((provider: string) => string | undefined) | undefined,
): void {
  customProviderInfoResolver = resolver;
}

/** Injected resolver returning the default model for a custom provider id. */
let customDefaultModelResolver:
  ((provider: ProviderId) => string | undefined) | undefined;

export function setCustomDefaultModelResolver(
  resolver: ((provider: ProviderId) => string | undefined) | undefined,
): void {
  customDefaultModelResolver = resolver;
}
