import Conf from "conf";
import { dirname } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Mode, ProviderId, ReasoningPreference } from "../types.js";
import type { ExaSearchType, SearchProviderId } from "../tools/web/types.js";
import { DEFAULT_EXA_SEARCH_TYPE } from "../tools/web/types.js";
import { defaultModels, sanitizeProviderModel } from "../llm/provider.js";
import type { CustomProviderDef } from "../llm/custom-providers.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwnerSync, handlePermissionError } from "../os/permissions.js";

export type ProviderCategory = "local" | "free-cloud" | "paid-cloud";

/** Endpoint URLs for one provider plus the sticky active choice. */
export interface ProviderEndpoints {
  urls: string[];
  activeIndex: number;
  disabledUrls?: string[] | undefined;
}

/** Same ceiling as API keys, so both editors behave identically. */
export const MAX_PROVIDER_ENDPOINTS = 10;

/**
 * Providers whose base URL is user-supplied. `modal` requires one (endpoints
 * are per-workspace); `lightning` treats it as an override of the shared
 * gateway, e.g. to point at a private Lightning Inference deployment.
 */
export const endpointProviders: readonly ProviderId[] = [
  "modal",
  "lightning",
  "tokenrouter",
];

export function providerUsesEndpoints(provider: ProviderId): boolean {
  if (endpointProviders.includes(provider)) return true;
  // Custom providers always carry a user-supplied base URL.
  return isCustomProviderIdSync(provider);
}

/** Environment override, checked before the stored list. */
const endpointEnvVars: Partial<Record<ProviderId, string>> = {
  modal: "MODAL_BASE_URL",
  lightning: "LIGHTNING_BASE_URL",
  tokenrouter: "TOKENROUTER_BASE_URL",
};

/** Resolve the env var for a provider (custom providers use their own envVar). */
function providerEndpointEnvVar(provider: ProviderId): string | undefined {
  if (endpointEnvVars[provider]) return endpointEnvVars[provider];
  const def = findCustomProviderDefSync(provider);
  return def?.envVar;
}

export type LearnedVisionEntry = boolean | { vision: boolean; at: string };

export interface ClaiConfig {
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultMode: Mode;
  providerModels: Partial<Record<ProviderId, string>>;
  allowAlwaysTools: string[];
  pentestAuthorized: boolean;
  sandboxRoots: string[];
  ollamaHost: string;
  /**
   * @deprecated Superseded by `providerEndpoints.modal`. Still read once so
   * configs written before multi-endpoint support keep working.
   */
  modalBaseUrl: string;
  /**
   * Endpoint URLs per provider, with a sticky active index — the same shape as
   * multi-key storage. Used by providers whose base URL belongs to the user
   * (Modal, one URL per deployed endpoint) or is overridable (Lightning AI,
   * whose default is the shared gateway).
   */
  providerEndpoints: Partial<Record<ProviderId, ProviderEndpoints>>;
  telemetry: boolean;
  lastUpdateCheck: number;
  thinking: ReasoningPreference;
  /** When true, exclude paid-cloud providers from the fallback chain. */
  freeOnly: boolean;
  /** When true, try other configured providers after the selected provider fails. */
  providerFallback: boolean;
  /** When true, suppress non-essential outbound calls (update check). */
  offline: boolean;
  /** When true, the agent only accepts ```tool / XML / Kimi sentinel tool calls. */
  parserStrict: boolean;
  /** When true, suppress writing chat history (in-memory only). */
  privateMode: boolean;
  /** Max number of session records kept in JSONL history (0 = unlimited). */
  historyRetentionLimit: number;
  /** When true, fs.read/list/search must stay within sandboxRoots ∪ {cwd, $HOME}. */
  sandboxReads: boolean;
  /** Active search provider used by the web.search tool. */
  activeSearchProvider: SearchProviderId;
  /** Exa retrieval strategy (`type`) applied when Exa is the active provider. */
  exaSearchType: ExaSearchType;
  /** When true, bypass the OS keychain and always use plaintext file storage. */
  disableKeychain: boolean;
  /** Permissions mode for auto-confirming tool calls ("default" or "allow-all"). */
  permissions?: "default" | "allow-all";
  learnedVisionCapabilities: Record<string, LearnedVisionEntry>;
  /**
   * Tool calling protocol:
   * - auto (default): native when dialect supports it, text fallback otherwise
   * - native: prefer native; still text-fallback on tools-unsupported
   * - text: force legacy fenced tool protocol
   */
  toolCalling?: "auto" | "native" | "text";

  // --- Reliability experiments (audit E1–E6); defaults are safe/on ---

  /** E1: auto-compact at softCompactTokenBudget before the hard 100k ceiling. */
  softEarlyCompact?: boolean;
  /** @deprecated Legacy soft trigger; migrated to autoCompactRequestTokens. */
  softCompactTokenBudget?: number;
  /** Total estimated request tokens that trigger auto-compaction. */
  autoCompactRequestTokens?: number;
  /** E2: max chars of fs.read/list/search body kept in model context (full on disk). */
  fsPassthroughCapChars?: number;
  /** E3: lower maxTokens on tool steps vs legacy 32k fixed. */
  adaptiveMaxTokens?: boolean;
  /** E4: advisory notices for free-cloud + large context / repeated failures. */
  freeTierContextGuard?: boolean;
  /** E4: token estimate that triggers a free-tier large-context notice. */
  freeTierWarnTokens?: number;
  /** E4: consecutive free-tier failures before a stronger switch-model notice. */
  freeTierFailThreshold?: number;
  /** E5: collapse identical tool result bodies within a turn to a pointer. */
  toolResultDedup?: boolean;
  /** E6: omit long fence-protocol tool encyclopedia when native tools are active. */
  slimNativePrompt?: boolean;
  /**
   * Durable per-route model-window overrides, keyed `provider:model`. Set via
   * the footer ctx-limit chip; survives history navigation and restarts.
   */
  contextLimitTokens?: Record<string, number>;
  /** User-defined OpenAI-compatible providers (added via /provider picker). */
  customProviders?: CustomProviderDef[];
}

/**
 * Best-effort classification for the built-in providers. Some "free-cloud"
 * providers have paid tiers too — the label reflects what the default keys
 * usually buy you. Users who set up paid OpenAI/Anthropic keys can flip
 * freeOnly off to opt back into them.
 */
export const providerCategory: Record<ProviderId, ProviderCategory> = {
  free: "free-cloud",
  groq: "free-cloud",
  gemini: "free-cloud",
  openrouter: "free-cloud",
  nvidia: "free-cloud",
  ollama: "local",
  openai: "paid-cloud",
  anthropic: "paid-cloud",
  agentrouter: "paid-cloud",
  kimchi: "free-cloud",
  "aws-mantle": "paid-cloud",
  bynara: "free-cloud",
  "qwen-cloud": "paid-cloud",
  // Usage-based compute billing. The Starter plan's $30/month credit makes it
  // free in practice for light use, but it still spends real money, so
  // `freeOnly` must keep it out of the fallback chain.
  modal: "paid-cloud",
  // Per-token billing after the introductory free-token grant, so keep it out
  // of `freeOnly` runs.
  lightning: "paid-cloud",
  // Prepaid balance, billed per token.
  tokenrouter: "paid-cloud",
  meta: "paid-cloud",
};

/**
 * Resolve the category for any provider id (built-in or custom). Custom
 * providers default to "paid-cloud" so `/freeonly` keeps them out of the
 * fallback chain unless the user explicitly switched to one.
 */
export function resolveProviderCategory(provider: ProviderId): ProviderCategory {
  return providerCategory[provider] ?? "paid-cloud";
}

const defaults: ClaiConfig = {
  defaultProvider: "free",
  defaultModel: defaultModels.free,
  defaultMode: "ask",
  providerModels: {},
  allowAlwaysTools: [],
  pentestAuthorized: false,
  sandboxRoots: [safeCwd()],
  ollamaHost: "http://localhost:11434",
  modalBaseUrl: "",
  providerEndpoints: {},
  telemetry: false,
  lastUpdateCheck: 0,
  thinking: { enabled: false, effort: "medium" },
  freeOnly: false,
  providerFallback: false,
  offline: false,
  parserStrict: false,
  privateMode: false,
  // 0 = unlimited. A low cap used to hard-delete older chats on every
  // autosave (slice-and-rewrite), which wiped classic clai history.
  historyRetentionLimit: 0,
  sandboxReads: false,
  activeSearchProvider: "duckduckgo",
  exaSearchType: DEFAULT_EXA_SEARCH_TYPE,
  disableKeychain: false,
  permissions: "default",
  toolCalling: "auto",
  softEarlyCompact: true,
  autoCompactRequestTokens: 180_000,
  fsPassthroughCapChars: 64_000,
  adaptiveMaxTokens: true,
  freeTierContextGuard: true,
  freeTierWarnTokens: 40_000,
  freeTierFailThreshold: 2,
  toolResultDedup: true,
  slimNativePrompt: true,
  learnedVisionCapabilities: {},
  contextLimitTokens: {},
  customProviders: [],
};

const store = (() => {
  try {
    const s = new Conf<ClaiConfig>({
      projectName: "clai",
      ...(process.env.CLAI_CONFIG_DIR ? { cwd: process.env.CLAI_CONFIG_DIR } : {}),
      defaults,
    });
    const dir = dirname(s.path);
    fixOwnerSync(dir);
    fixOwnerSync(s.path);
    return s;
  } catch (err: any) {
    handlePermissionError(err);
  }
})();

// Inject the custom-provider id resolver so `normalizeProvider`/`assertProvider`
// recognise user-defined provider ids. Done once, after the store is live.
import { setCustomDefaultModelResolver, setCustomProviderInfoResolver, setCustomProviderResolver, setEnvVarResolver } from "../llm/provider.js";
setCustomProviderResolver((id: string): boolean => {
  const list = getConfig().customProviders ?? [];
  return list.some((d) => d.id === id);
});
setEnvVarResolver((provider) => findCustomProviderDefSync(provider)?.envVar);
setCustomDefaultModelResolver((provider) => findCustomProviderDefSync(provider)?.defaultModel);
setCustomProviderInfoResolver((provider) => {
  const def = findCustomProviderDefSync(provider);
  if (!def) return undefined;
  const env = def.envVar ? `\nENVIRONMENT VARIABLE\n  ${def.envVar}  API key (used when nothing is stored)\n` : "";
  return `${def.displayName} — custom OpenAI-compatible provider

CONFIGURATION
  id:            ${def.id}
  base URL:      ${def.baseUrl}
  default model: ${def.defaultModel}${env}

MANAGING KEYS
  clai set ${def.id} <key>       add an API key (up to 10, rotated on failure)
  clai set ${def.id} <key2>      add another; the last that worked is sticky
  /set ${def.id}                 multi-key editor
  clai unset ${def.id}           remove every stored key

This provider was added manually via the /provider picker. It speaks the
standard OpenAI Chat Completions API (/chat/completions, /models, SSE
streaming, native tool calling, reasoning_effort). Use /model to pick from
the live catalogue fetched from ${def.baseUrl}/models.`;
});

let cachedConfig: { key: string; value: ClaiConfig } | undefined;

/** Cheap identity of the on-disk config so external edits invalidate the cache. */
function configFileKey(): string | undefined {
  try {
    const info = statSync(store.path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}

function invalidateConfigCache(): void {
  cachedConfig = undefined;
}

/** Fresh mutable view over the cached snapshot; callers may edit their copy. */
function cloneConfig(config: ClaiConfig): ClaiConfig {
  const providerEndpoints: Partial<Record<ProviderId, ProviderEndpoints>> = {};
  for (const [provider, value] of Object.entries(config.providerEndpoints ?? {}) as Array<
    [ProviderId, ProviderEndpoints]
  >) {
    providerEndpoints[provider] = {
      urls: [...(value?.urls ?? [])],
      activeIndex: value?.activeIndex ?? 0,
    };
  }
  return {
    ...config,
    providerEndpoints,
    providerModels: { ...config.providerModels },
    allowAlwaysTools: [...config.allowAlwaysTools],
    sandboxRoots: [...config.sandboxRoots],
    thinking: { ...config.thinking },
    contextLimitTokens: { ...(config.contextLimitTokens ?? {}) },
    customProviders: (config.customProviders ?? []).map((d) => ({ ...d })),
  };
}

const COMPACTION_DEFAULT_TOKENS = 180_000;

function migrateCompactionBudgetKeys(): void {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(store.path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const stale = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value < COMPACTION_DEFAULT_TOKENS;
  const auto = raw.autoCompactRequestTokens;
  const legacy = raw.softCompactTokenBudget;
  if (!stale(auto) && !stale(legacy)) return;
  const next: Record<string, unknown> = { ...raw };
  if (stale(auto)) delete next.autoCompactRequestTokens;
  if (stale(legacy)) delete next.softCompactTokenBudget;
  try {
    writeFileSync(store.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fixOwnerSync(store.path);
    invalidateConfigCache();
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export function getConfig(): ClaiConfig {
  const key = configFileKey();
  if (key !== undefined && cachedConfig?.key === key) {
    return cloneConfig(cachedConfig.value);
  }
  migrateCompactionBudgetKeys();
  const resolved = readConfigFromStore();
  const freshKey = configFileKey();
  if (freshKey !== undefined) cachedConfig = { key: freshKey, value: resolved };
  return cloneConfig(resolved);
}

function readConfigFromStore(): ClaiConfig {
  const current = store.store;
  const providerModels: Partial<Record<ProviderId, string>> = {};
  for (const [provider, model] of Object.entries(current.providerModels ?? {}) as Array<
    [ProviderId, string]
  >) {
    providerModels[provider] = sanitizeProviderModel(provider, model);
  }
  return {
    ...current,
    defaultModel: sanitizeProviderModel(
      current.defaultProvider,
      current.defaultModel,
    ),
    providerModels,
  };
}

// --- Custom provider definitions (user-defined, runtime registry) --------------

/** All custom provider defs stored in config. */
export function getCustomProviders(): CustomProviderDef[] {
  const list = getConfig().customProviders ?? [];
  return list.map((d) => ({ ...d }));
}

/** True when `id` matches a user-defined custom provider (sync, reads config). */
export function isCustomProviderIdSync(id: string | ProviderId): boolean {
  const list = getConfig().customProviders ?? [];
  return list.some((d) => d.id === id);
}

/** Resolve a custom definition by id (sync). */
export function findCustomProviderDefSync(
  id: string | ProviderId,
): CustomProviderDef | undefined {
  const list = getConfig().customProviders ?? [];
  const found = list.find((d) => d.id === id);
  return found ? { ...found } : undefined;
}

/** Persist a new custom provider definition. Throws on duplicate id. */
export function addCustomProvider(def: CustomProviderDef): CustomProviderDef {
  const current = getConfig().customProviders ?? [];
  if (current.some((d) => d.id === def.id)) {
    throw new Error(`custom provider "${def.id}" already exists`);
  }
  updateConfig({ customProviders: [...current, def] });
  return def;
}

/** Remove a custom provider definition (does not touch its stored keys). */
export function removeCustomProvider(id: string): boolean {
  const current = getConfig().customProviders ?? [];
  const next = current.filter((d) => d.id !== id);
  if (next.length === current.length) return false;
  updateConfig({ customProviders: next });
  return true;
}


export function updateConfig(patch: Partial<ClaiConfig>): ClaiConfig {
  const next = { ...getConfig(), ...patch } satisfies ClaiConfig;
  try {
    store.set(next);
    fixOwnerSync(store.path);
  } catch (err: any) {
    handlePermissionError(err);
  }
  invalidateConfigCache();
  return getConfig();
}

export function setDefaultProvider(provider: ProviderId): ClaiConfig {
  const model = getProviderModel(provider);
  return updateConfig({ defaultProvider: provider, defaultModel: model });
}

export function setDefaultMode(mode: Mode): ClaiConfig {
  return updateConfig({ defaultMode: mode });
}

export function setProviderModel(
  provider: ProviderId,
  model: string,
): ClaiConfig {
  const current = getConfig();
  const sanitized = sanitizeProviderModel(provider, model);
  const providerModels = { ...current.providerModels, [provider]: sanitized };
  return updateConfig({
    providerModels,
    ...(current.defaultProvider === provider ? { defaultModel: sanitized } : {}),
  });
}

/**
 * Every stored endpoint URL for a provider plus the sticky active index.
 * A pre-multi-endpoint `modalBaseUrl` is folded in as the single entry so old
 * configs keep working without a migration step.
 */
export function getProviderEndpoints(provider: ProviderId): ProviderEndpoints {
  const config = getConfig();
  const stored = config.providerEndpoints?.[provider];
  const urls = (stored?.urls ?? []).map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0 && provider === "modal") {
    const legacy = config.modalBaseUrl?.trim();
    if (legacy) urls.push(legacy);
  }
  // Custom providers seed their endpoint list from the stored base URL so the
  // editor / `clai keys` shows it even before the user adds more via --url.
  if (urls.length === 0) {
    const customDef = findCustomProviderDefSync(provider);
    if (customDef?.baseUrl) urls.push(customDef.baseUrl);
  }
  const activeIndex =
    urls.length > 0
      ? Math.min(Math.max(stored?.activeIndex ?? 0, 0), urls.length - 1)
      : 0;
  const disabledUrls = (stored?.disabledUrls ?? []).filter((url) =>
    urls.includes(url),
  );
  return {
    urls,
    activeIndex,
    ...(disabledUrls.length > 0 ? { disabledUrls } : {}),
  };
}

/** Replace the whole list (endpoint editor Save). Empty list clears it. */
export function setProviderEndpoints(
  provider: ProviderId,
  urls: readonly string[],
  activeIndex = 0,
  disabledUrls?: readonly string[],
): ProviderEndpoints {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
    if (unique.length >= MAX_PROVIDER_ENDPOINTS) break;
  }
  const previousDisabled = getConfig().providerEndpoints?.[provider]?.disabledUrls ?? [];
  const nextDisabled = (disabledUrls ?? previousDisabled).filter((url) =>
    unique.includes(url),
  );
  const next: ProviderEndpoints = {
    urls: unique,
    activeIndex:
      unique.length > 0 ? Math.min(Math.max(activeIndex, 0), unique.length - 1) : 0,
    ...(nextDisabled.length > 0 ? { disabledUrls: nextDisabled } : {}),
  };
  const providerEndpoints = { ...getConfig().providerEndpoints, [provider]: next };
  const patch: Partial<ClaiConfig> = { providerEndpoints };
  // Retire the legacy single field once the list owns the value, so the two
  // cannot drift apart.
  if (provider === "modal") patch.modalBaseUrl = "";
  updateConfig(patch);
  return next;
}

/**
 * Add one endpoint and make it active. Re-adding a known URL just activates it,
 * which doubles as the CLI's way to switch endpoints.
 */
export function appendProviderEndpoint(
  provider: ProviderId,
  url: string,
): { endpoints: ProviderEndpoints; added: boolean } {
  const trimmed = url.trim();
  const current = getProviderEndpoints(provider);
  const existing = current.urls.indexOf(trimmed);
  if (existing >= 0) {
    return {
      endpoints: setProviderEndpoints(provider, current.urls, existing),
      added: false,
    };
  }
  if (current.urls.length >= MAX_PROVIDER_ENDPOINTS) {
    throw new Error(
      `at most ${MAX_PROVIDER_ENDPOINTS} endpoint URLs per provider`,
    );
  }
  const urls = [...current.urls, trimmed];
  return {
    endpoints: setProviderEndpoints(provider, urls, urls.length - 1),
    added: true,
  };
}

export function setActiveProviderEndpoint(
  provider: ProviderId,
  index: number,
): ProviderEndpoints {
  const current = getProviderEndpoints(provider);
  return setProviderEndpoints(provider, current.urls, index);
}

export function setProviderEndpointDisabled(
  provider: ProviderId,
  url: string,
  disabled: boolean,
): ProviderEndpoints {
  const current = getProviderEndpoints(provider);
  const trimmed = url.trim();
  const disabledUrls = new Set(current.disabledUrls ?? []);
  if (disabled) {
    if (current.urls.includes(trimmed)) disabledUrls.add(trimmed);
  } else {
    disabledUrls.delete(trimmed);
  }
  return setProviderEndpoints(
    provider,
    current.urls,
    current.activeIndex,
    [...disabledUrls],
  );
}

/**
 * The base URL a request should use. The provider's env override wins so a
 * shell can retarget clai without rewriting config; otherwise the sticky active
 * entry. Returns "" when nothing is configured — providers that require one
 * turn that into an actionable error, and Lightning falls back to its gateway.
 */
export function getActiveProviderEndpoint(provider: ProviderId): string {
  const envVar = providerEndpointEnvVar(provider);
  const fromEnv = envVar ? process.env[envVar]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  const { urls, activeIndex, disabledUrls } = getProviderEndpoints(provider);
  if (urls.length === 0) return "";
  const disabled = new Set(disabledUrls ?? []);
  for (let offset = 0; offset < urls.length; offset += 1) {
    const candidate = urls[(activeIndex + offset) % urls.length]!;
    if (!disabled.has(candidate)) return candidate;
  }
  return "";
}

export function getProviderModel(provider: ProviderId): string {
  const configured = getConfig().providerModels[provider];
  if (configured) return sanitizeProviderModel(provider, configured);
  // Custom providers carry their own default model; built-ins use defaultModels.
  const customDef = findCustomProviderDefSync(provider);
  if (customDef) return customDef.defaultModel;
  return defaultModels[provider];
}

/**
 * True when the user (or a migration) actually persisted this key. Defaults are
 * resolved by Conf, so a resolved value alone cannot prove intent — the raw file
 * is the only honest source for migration decisions.
 */
export function hasExplicitConfigKey(key: keyof ClaiConfig): boolean {
  try {
    const raw = JSON.parse(readFileSync(store.path, "utf8")) as Record<
      string,
      unknown
    >;
    return Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

export function getConfigPath(): string {
  return store.path;
}

export function setThinking(patch: Partial<ReasoningPreference>): ClaiConfig {
  const current = getConfig().thinking;
  const next: ReasoningPreference = {
    enabled: patch.enabled ?? current.enabled,
    effort: patch.effort ?? current.effort,
  };
  return updateConfig({ thinking: next });
}

export function getActiveSearchProvider(): SearchProviderId {
  return getConfig().activeSearchProvider;
}

export function setActiveSearchProvider(id: SearchProviderId): ClaiConfig {
  return updateConfig({ activeSearchProvider: id });
}

export function getExaSearchType(): ExaSearchType {
  return getConfig().exaSearchType ?? DEFAULT_EXA_SEARCH_TYPE;
}

export function setExaSearchType(type: ExaSearchType): ClaiConfig {
  return updateConfig({ exaSearchType: type });
}
