/**
 * Picker-backed slash commands: model/provider/search/reasoning/history/
 * permissions/output/plan (V2-072, V2-080).
 */

import { getProvider, providerAuth } from "../../llm/router.js";
import { defaultModels, normalizeEndpointUrl } from "../../llm/provider.js";
import { modelSupportsThinking } from "../../llm/capabilities.js";
import { assertProvider } from "../../llm/provider.js";
import { assertSearchProvider } from "../../tools/web/providers/provider.js";
import { searchProviders } from "../../tools/web/providers/provider.js";
import {
  asExaSearchType,
  exaSearchTypeDescriptions,
  exaSearchTypes,
  searchProviderIds,
  type ExaSearchType,
  type SearchProviderId,
} from "../../tools/web/types.js";
import { providerIds, type ProviderId, type ReasoningEffort } from "../../types.js";
import { getKnownModels } from "../../app/commands/catalog.js";
import { clearActiveProjectRoot } from "../../agent/project-root.js";
import {
  appendProviderEndpoint,
  getActiveProviderEndpoint,
  addCustomProvider,
  getCustomProviders,
  removeCustomProvider,
  getConfig,
  getExaSearchType,
  getProviderModel,
  setActiveSearchProvider,
  setDefaultProvider,
  setExaSearchType,
  setProviderModel,
  setThinking,
  updateConfig,
} from "../../store/config.js";
import {
  envValue,
  getProviderSecret,
  getSearchProviderKey,
  setProviderSecret,
  setSecret,
  unsetProviderSecret,
} from "../../store/keys.js";
import {
  getCustomProviderIds,
  invalidateCustomProviderCache,
  materializeCustomProvider,
  normalizeCustomBaseUrl,
  normalizeCustomProviderId,
  type CustomProviderDef,
} from "../../llm/custom-providers.js";
import {
  deleteSession,
  getSession,
  listSessionSummaries,
  purgeSession,
} from "../../store/history.js";
import { relativeTime, shortCwd } from "../rendering/text-format.js";
import { conversationItemCount } from "../state/transcript-types.js";
import {
  boundSessionVisualInput,
  hydrateSessionVisual,
  transcriptLooksIncomplete,
} from "../state/transcript-hydrate.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import { openToolOutputPager } from "../rendering/open-tool-output.js";

const REASONING_DESCRIPTIONS: Record<string, string> = {
  off: "disable reasoning",
  minimal: "lowest latency",
  low: "light reasoning",
  medium: "balanced",
  high: "deep reasoning",
  xhigh: "maximum depth",
  max: "highest supported depth",
};

/**
 * Live provider model catalogue (matches classic TUI `/model`).
 * Prefers `provider.listModels`; falls back to the static known list.
 */
export async function resolveModelsForProvider(
  provider: ProviderId,
  currentModel?: string | undefined,
): Promise<{ models: string[]; source: "live" | "known"; error?: string }> {
  const providerImpl = getProvider(provider);
  let models: string[] = [];
  let error: string | undefined;

  if (providerImpl.listModels) {
    try {
      const auth = await providerAuth(provider);
      models = await providerImpl.listModels(auth);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  let source: "live" | "known" = "live";
  if (models.length === 0) {
    models = getKnownModels(provider);
    source = "known";
  }

  if (currentModel && !models.includes(currentModel)) {
    models = [currentModel, ...models];
  }
  return error ? { models, source, error } : { models, source };
}

export async function handleModel(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const state = services.session.getState();
  const provider = state.provider ?? getConfig().defaultProvider;
  const arg = invocation.args.trim();
  if (arg && arg !== "list" && arg !== "ls") {
    applyModel(services, provider, arg, getKnownModels(provider));
    return;
  }

  const fetchingToastId = services.toast.info(`fetching ${provider} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  const { models, source, error } = await resolveModelsForProvider(provider, state.model);
  services.toast.dismiss(fetchingToastId);
  if (error) {
    services.session.notice(
      "warn",
      `could not refresh ${provider} models: ${error} · showing known models`,
    );
  } else if (source === "known" && getProvider(provider).listModels) {
    services.session.notice(
      "warn",
      `${provider} model list empty from API · showing known models`,
    );
  } else if (source === "live") {
    services.session.notice("info", `${provider} · ${models.length} models (live)`);
  }

  if (models.length === 0) {
    services.session.notice(
      "info",
      `no models for ${provider} — type /model <name> to set one manually`,
    );
    return;
  }

  services.overlay.openPicker(
    {
      title: `Models · ${provider}${source === "live" ? " · live" : ""}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === state.model,
      })),
    },
    (value) => {
      applyModel(services, provider, value, models);
      services.overlay.close();
    },
  );
}

const CATALOG_SEPARATOR = "\u001f";

interface CatalogEntry {
  readonly provider: ProviderId;
  readonly model: string;
  readonly live: boolean;
}

async function configuredProviderIds(): Promise<ProviderId[]> {
  const custom = getCustomProviders().map((def) => def.id as ProviderId);
  const candidates: ProviderId[] = [...providerIds, ...custom];
  const configured = await Promise.all(
    candidates.map(async (provider) => {
      if (provider === "ollama" || provider === "free") return provider;
      const hasKey =
        Boolean(envValue(provider)) ||
        Boolean((await getProviderSecret(provider)).value);
      if (!hasKey) return undefined;
      if (provider === "modal" && !getActiveProviderEndpoint("modal")) {
        return undefined;
      }
      return provider;
    }),
  );
  return configured.filter((provider): provider is ProviderId => Boolean(provider));
}

async function collectAllModels(): Promise<{
  entries: CatalogEntry[];
  providers: number;
  liveProviders: number;
  failed: ProviderId[];
}> {
  const providers = await configuredProviderIds();
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const resolved = await resolveModelsForProvider(provider);
        return { provider, ...resolved };
      } catch (error) {
        return {
          provider,
          models: getKnownModels(provider),
          source: "known" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const entries: CatalogEntry[] = [];
  const failed: ProviderId[] = [];
  let liveProviders = 0;
  for (const result of results) {
    if (result.error) failed.push(result.provider);
    if (result.source === "live") liveProviders += 1;
    const seen = new Set<string>();
    for (const model of result.models) {
      const id = model.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        provider: result.provider,
        model: id,
        live: result.source === "live",
      });
    }
  }
  entries.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  return { entries, providers: providers.length, liveProviders, failed };
}

async function switchToCatalogEntry(
  services: AppServices,
  entry: CatalogEntry,
): Promise<void> {
  const state = services.session.getState();
  const current = state.provider ?? getConfig().defaultProvider;
  if (entry.provider !== current) {
    setDefaultProvider(entry.provider);
    services.session.setProvider(entry.provider);
    clearActiveProjectRoot();
  }
  services.session.setModel(entry.model);
  setProviderModel(entry.provider, entry.model);
  services.session.notice(
    "info",
    `provider → ${entry.provider} · model → ${entry.model}`,
  );
}

export async function handleModels(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const fetching = services.toast.info("collecting models from all providers…", {
    key: "models-fetch",
    sticky: true,
  });
  const { entries, providers, liveProviders, failed } = await collectAllModels();
  services.toast.dismiss(fetching);

  if (entries.length === 0) {
    services.session.notice(
      "warn",
      "no models found — configure a provider key with /set first",
    );
    return;
  }

  const filter = invocation.args.trim().toLowerCase();
  if (filter) {
    const normalized = filter.replace(/\s+/g, "/");
    const matches = entries.filter((entry) => {
      const combined = `${entry.provider}/${entry.model}`.toLowerCase();
      return combined === normalized || combined.includes(normalized);
    });
    const exact = matches.find(
      (entry) => `${entry.provider}/${entry.model}`.toLowerCase() === normalized,
    );
    if (exact) {
      await switchToCatalogEntry(services, exact);
      return;
    }
    if (matches.length === 1) {
      await switchToCatalogEntry(services, matches[0]!);
      return;
    }
    if (matches.length === 0) {
      services.session.notice("warn", `no model matches "${invocation.args.trim()}"`);
      return;
    }
  }

  const state = services.session.getState();
  const activeProvider = state.provider ?? getConfig().defaultProvider;
  if (failed.length > 0) {
    services.session.notice(
      "warn",
      `could not refresh ${failed.join(", ")} · showing known models for those`,
    );
  }
  services.session.notice(
    "info",
    `${entries.length} models · ${providers} provider${providers === 1 ? "" : "s"} configured · ${liveProviders} live`,
  );

  services.overlay.openPicker(
    {
      title: `All models · ${providers} providers`,
      searchDescription: true,
      twoLine: true,
      options: entries.map((entry) => ({
        value: `${entry.provider}${CATALOG_SEPARATOR}${entry.model}`,
        label: `${entry.provider} / ${entry.model}`,
        description: entry.live ? "live catalogue" : "known models",
        active: entry.provider === activeProvider && entry.model === state.model,
      })),
    },
    (value) => {
      services.overlay.close();
      const separator = value.indexOf(CATALOG_SEPARATOR);
      if (separator <= 0) return;
      const provider = value.slice(0, separator);
      const model = value.slice(separator + 1);
      const entry = entries.find(
        (candidate) =>
          candidate.provider === provider && candidate.model === model,
      );
      if (!entry) return;
      void switchToCatalogEntry(services, entry);
    },
  );
}

function applyModel(
  services: AppServices,
  provider: ProviderId,
  model: string,
  options: readonly string[] = getKnownModels(provider),
): void {
  const index = Number.parseInt(model, 10);
  const next =
    Number.isInteger(index) && index >= 1 && index <= options.length
      ? options[index - 1]!
      : model;
  services.session.setModel(next);
  setProviderModel(provider, next);
  services.session.notice("info", `model → ${next}`);
}

/** Sentinel value returned by the /provider picker for "add a custom provider". */
const ADD_CUSTOM_PROVIDER = "__add_custom_provider__";

/** Sentinel for the "remove a custom provider" picker row. */
const REMOVE_CUSTOM_PROVIDER = "__remove_custom_provider__";

export function handleProvider(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    try {
      void activateProvider(services, assertProvider(invocation.args.trim()));
    } catch {
      services.session.notice("warn", `unknown provider: ${invocation.args.trim()}`);
    }
    return;
  }
  void (async () => {
    const current = services.session.getState().provider ?? getConfig().defaultProvider;
    // Custom (user-defined) providers appear after the built-ins, plus
    // dedicated rows at the top to launch the add / remove flows.
    const { getCustomProviders } = await import("../../store/config.js");
    const custom = getCustomProviders();
    const options: PickerOption[] = [
      {
        value: ADD_CUSTOM_PROVIDER,
        label: "+ Add custom provider",
        description: "connect an OpenAI-compatible endpoint not listed above",
      },
      // Only offer removal when at least one custom provider exists.
      ...(custom.length > 0
        ? [
            {
              value: REMOVE_CUSTOM_PROVIDER,
              label: "− Remove custom provider",
              description: `${custom.length} custom provider${custom.length === 1 ? "" : "s"} · delete a definition + its keys`,
            },
          ]
        : []),
      ...providerIds.map((value) => ({
        value,
        label: value,
        description: getProviderModel(value),
        active: value === current,
      })),
      ...custom.map((def) => ({
        value: def.id,
        label: def.id,
        description: getProviderModel(def.id as ProviderId),
        active: def.id === current,
      })),
    ];
    services.overlay.openPicker(
      {
        title: "Providers",
        // Search provider name + model name.
        searchDescription: true,
        options,
      },
      (value) => {
        if (value === ADD_CUSTOM_PROVIDER) {
          void addCustomProviderFlow(services);
          return;
        }
        if (value === REMOVE_CUSTOM_PROVIDER) {
          void removeCustomProviderFlow(services);
          return;
        }
        void activateProvider(services, assertProvider(value));
      },
    );
  })();
}

async function activateProvider(services: AppServices, next: ProviderId): Promise<void> {
  // Modal needs two separate things, so it gets its own onboarding.
  if (next === "modal") {
    if (!(await ensureModalCredentials(services))) return;
  } else {
    const configured =
      next === "ollama" || next === "free" || Boolean(envValue(next)) || Boolean((await getProviderSecret(next)).value);
    if (!configured) {
      services.overlay.close();
      const key = await services.overlay.openSecret({
        title: `${next} API key`,
        prompt: `No API key is configured for ${next}. Enter it now to activate this provider.`,
      });
      const value = key?.trim();
      if (!value) {
        services.session.notice("info", `cancelled · provider unchanged`);
        return;
      }
      // Silence here used to look like the picker had simply ignored the input.
      if (!getProvider(next).validateKey(value)) {
        services.session.notice(
          "warn",
          `invalid API key format for ${next} · provider unchanged`,
        );
        return;
      }
      await setProviderSecret(next, value);
    }
  }
  const model = getProviderModel(next);
  setDefaultProvider(next);
  services.session.setProvider(next);
  services.session.setModel(model);
  services.overlay.close();
  services.session.notice("info", `provider → ${next} · model → ${model}`);
}

/**
 * Modal is the only provider that needs two things before it can serve a
 * request: the workspace endpoint URL (config) and a proxy token pair
 * (secret). Ask for whichever is missing, endpoint first — that is the value
 * people reach for, and a URL typed into a token prompt used to fail
 * `validateKey` and silently abandon the switch.
 *
 * Returns false when the user cancelled or entered something unusable, in
 * which case the active provider is left alone.
 */
async function ensureModalCredentials(services: AppServices): Promise<boolean> {
  const hasToken =
    Boolean(envValue("modal")) || Boolean((await getProviderSecret("modal")).value);

  if (!getActiveProviderEndpoint("modal")) {
    services.overlay.close();
    const answer = await services.overlay.openSecret({
      title: hasToken ? "Modal endpoint URL" : "Modal endpoint URL (1 of 2)",
      prompt:
        "Paste your Modal endpoint URL, e.g. https://<workspace>--ep-<endpoint>.<region>.modal.direct",
      reveal: true,
    });
    const url = answer?.trim();
    if (!url) {
      services.session.notice("info", "cancelled · provider unchanged");
      return false;
    }
    const endpoint = normalizeEndpointUrl(url);
    appendProviderEndpoint("modal", endpoint);
    services.session.notice("info", `modal endpoint → ${endpoint}`);
  }

  if (!hasToken) {
    services.overlay.close();
    const answer = await services.overlay.openSecret({
      title: "Modal proxy token (2 of 2)",
      prompt:
        "Enter the proxy token pair as <token-id>:<token-secret> — create one with: modal workspace proxy-tokens create",
    });
    const token = answer?.trim();
    if (!token) {
      services.session.notice("info", "cancelled · provider unchanged");
      return false;
    }
    // Another URL means the user is still answering the previous question.
    if (/^https?:\/\//i.test(token)) {
      const endpoint = normalizeEndpointUrl(token);
      appendProviderEndpoint("modal", endpoint);
      services.session.notice(
        "warn",
        `saved that as the endpoint (${endpoint}) · modal still needs a wk-…:ws-… token pair — run /provider modal again`,
      );
      return false;
    }
    if (!getProvider("modal").validateKey(token)) {
      services.session.notice(
        "warn",
        "expected a proxy token pair like wk-tokenId:ws-tokenSecret · provider unchanged",
      );
      return false;
    }
    await setProviderSecret("modal", token);
  }

  return true;
}

/**
 * Add a user-defined (custom) provider. Walks the operator through every
 * required field, then fetches the live model catalogue from the endpoint and
 * lets them pick a default model before activating the new provider.
 *
 * Every prompt is a single `openSecret` modal (re-used for non-secret values
 * with `reveal: true`), so the flow works in both the OpenTUI and classic TUI.
 * Cancelling any step leaves the active provider untouched.
 */
async function addCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();

  // Existing ids (built-in + custom) so we can reject collisions up front.
  const existingBuiltins = providerIds as readonly string[];
  const existingCustom = getCustomProviders().map((d) => d.id);
  const existing = [...existingBuiltins, ...existingCustom];

  // 1. Provider id — a URL-safe slug used as the key namespace and config key.
  const idAnswer = await services.overlay.openSecret({
    title: "New custom provider · 1 of 5 · id",
    prompt:
      "Enter a short id (lowercase, a-z 0-9 and hyphens, e.g. myllm). This is how clai names the provider internally.",
    reveal: true,
  });
  const id = normalizeCustomProviderId(idAnswer?.trim() ?? "", existing);
  if (!id) {
    services.session.notice(
      "info",
      idAnswer?.trim()
        ? `"${idAnswer!.trim()}" is not a unique provider id (use lowercase a-z 0-9 hyphens)`
        : "cancelled · provider unchanged",
    );
    return;
  }

  // 2. Display name — shown in pickers and toasts.
  const nameAnswer = await services.overlay.openSecret({
    title: `New custom provider · 2 of 5 · name`,
    prompt: `Enter a display name for "${id}" (shown in pickers), e.g. My LLM Gateway:`,
    reveal: true,
  });
  const displayName = nameAnswer?.trim() || id;

  // 3. Base URL — the OpenAI-compatible endpoint root (clai appends /v1).
  const urlAnswer = await services.overlay.openSecret({
    title: `New custom provider · 3 of 5 · base URL`,
    prompt: `Paste the base URL for ${displayName} (OpenAI-compatible). e.g. https://api.example.com/v1`,
    reveal: true,
  });
  const baseUrl = normalizeCustomBaseUrl(urlAnswer?.trim() ?? "");
  if (!baseUrl) {
    services.session.notice("info", "cancelled · provider unchanged");
    return;
  }

  // 4. API key — masked; stored under the multi-key envelope so /set can add
  //    more later and the rotation logic treats it like any other provider.
  const keyAnswer = await services.overlay.openSecret({
    title: `New custom provider · 4 of 5 · API key`,
    prompt: `Enter the API key / bearer token for ${displayName} (input hidden). Leave blank to skip and set it later with /set ${id}.`,
  });
  const apiKey = keyAnswer?.trim() ?? "";

  // 5. Default model — fetch the live /models list and let the user pick.
  //    We materialise the provider in memory (before persisting) so the
  //    listModels call works without a config round-trip.
  const tempDef: CustomProviderDef = {
    id,
    displayName,
    baseUrl,
    defaultModel: "", // filled after the model pick
  };
  const tempProvider = materializeCustomProvider(tempDef);
  const fetchingToastId = services.toast.info(`fetching ${displayName} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  let models: string[] = [];
  try {
    const list = tempProvider.listModels;
    if (list) models = await list({ apiKey: apiKey || undefined });
  } catch (err) {
    services.session.notice(
      "warn",
      `could not fetch models from ${displayName}: ${err instanceof Error ? err.message : String(err)} · you can set one manually with /model <name>`,
    );
  } finally {
    services.toast.dismiss(fetchingToastId);
  }

  let defaultModel = "";
  if (models.length > 0) {
    services.overlay.close();
    const picked = await new Promise<string | undefined>((resolve) => {
      const opened = services.overlay.openPicker(
        {
          title: `Models · ${displayName} · live`,
          options: models.map((value) => ({ value, label: value })),
        },
        (value) => resolve(value),
      );
      if (!opened) resolve(undefined);
    });
    services.overlay.close();
    defaultModel = picked?.trim() ?? "";
    if (!defaultModel) {
      services.session.notice("info", "cancelled · provider unchanged");
      return;
    }
  } else {
    // No live list (key skipped or fetch failed): ask for a model name to use
    // as the default so the provider is usable immediately.
    const modelAnswer = await services.overlay.openSecret({
      title: `New custom provider · 5 of 5 · default model`,
      prompt: `Enter the default model id for ${displayName} (you can change it later with /model <name>):`,
      reveal: true,
    });
    defaultModel = modelAnswer?.trim() ?? "";
    if (!defaultModel) {
      services.session.notice("info", "cancelled · provider unchanged");
      return;
    }
  }

  // Persist the definition + the key + the chosen model, then activate.
  const def: CustomProviderDef = { id, displayName, baseUrl, defaultModel };
  addCustomProvider(def);
  invalidateCustomProviderCache(id);
  if (apiKey) {
    await setProviderSecret(id as ProviderId, apiKey);
  }
  setProviderModel(id as ProviderId, defaultModel);
  setDefaultProvider(id as ProviderId);
  services.session.setProvider(id as ProviderId);
  services.session.setModel(defaultModel);
  services.overlay.close();
  services.session.notice(
    "info",
    `added custom provider ${displayName} (${id}) · model → ${defaultModel}${apiKey ? "" : " · no key set (use /set " + id + " <key>)"}`,
  );
}

/**
 * Remove a user-defined (custom) provider. Lists only custom providers in a
 * picker, asks for confirmation, then tears down everything clai stored for
 * it: the definition, the multi-key envelope, the per-provider model and
 * endpoint overrides, and the in-memory provider cache. If the removed
 * provider was the active/default one, switches back to the nvidia default so
 * the session never points at a now-unknown id.
 */
async function removeCustomProviderFlow(services: AppServices): Promise<void> {
  services.overlay.close();
  const custom = getCustomProviders();
  if (custom.length === 0) {
    services.session.notice("info", "no custom providers to remove");
    return;
  }
  const config = getConfig();
  const activeProvider = services.session.getState().provider ?? config.defaultProvider;

  // 1. Pick which custom provider to delete.
  const picked = await new Promise<string | undefined>((resolve) => {
    const opened = services.overlay.openPicker(
      {
        title: "Remove custom provider",
        options: custom.map((def) => ({
          value: def.id,
          label: def.id,
          description: `${def.displayName} · ${def.baseUrl}`,
          active: def.id === activeProvider,
        })),
      },
      (value) => resolve(value),
    );
    if (!opened) resolve(undefined);
  });
  services.overlay.close();
  if (!picked) {
    services.session.notice("info", "cancelled · nothing removed");
    return;
  }

  const def = custom.find((d) => d.id === picked);
  const displayName = def?.displayName ?? picked;

  // 2. Confirm — deletion is irreversible (clears keys + model + endpoints).
  const confirmed = await services.overlay.openConfirm({
    kind: "reset",
    prompt: `Remove custom provider "${displayName}" (${picked})?\n\nThis deletes its definition, all stored API keys, and the per-provider model + endpoint overrides. This cannot be undone.`,
  });
  services.overlay.close();
  if (!confirmed) {
    services.session.notice("info", "cancelled · nothing removed");
    return;
  }

  // 3. Tear down: definition, keys, model override, endpoint list, cache.
  removeCustomProvider(picked);
  try {
    await unsetProviderSecret(picked as ProviderId);
  } catch {
    // No key stored (or env-only) — nothing to delete; not an error.
  }
  // Clear the per-provider model + endpoint overrides so they don't linger.
  const providerModels = { ...getConfig().providerModels };
  delete providerModels[picked as ProviderId];
  const providerEndpoints = { ...getConfig().providerEndpoints };
  delete providerEndpoints[picked as ProviderId];
  updateConfig({ providerModels, providerEndpoints });
  invalidateCustomProviderCache(picked);

  // 4. If we just deleted the active/default provider, switch to a safe
  //    built-in so the next request doesn't target a now-unknown id.
  if (picked === activeProvider || picked === config.defaultProvider) {
    const fallback = "nvidia" as ProviderId;
    setDefaultProvider(fallback);
    services.session.setProvider(fallback);
    services.session.setModel(getProviderModel(fallback));
    services.session.notice(
      "info",
      `removed custom provider ${displayName} (${picked}) · switched to ${fallback}`,
    );
  } else {
    services.session.notice(
      "info",
      `removed custom provider ${displayName} (${picked})`,
    );
  }
}

export function handleSearch(services: AppServices, invocation: CommandInvocation): void {
  const args = invocation.args.trim();
  if (args) {
    const parts = args.split(/\s+/);
    const providerArg = parts[0]!;
    // `/search exa <type>` sets Exa's retrieval strategy directly.
    if (providerArg.toLowerCase() === "exa" && parts.length > 1) {
      const type = asExaSearchType(parts.slice(1).join(" "));
      if (!type) {
        services.session.notice(
          "warn",
          `unknown exa search type: ${parts.slice(1).join(" ")} · options: ${exaSearchTypes.join(", ")}`,
        );
        return;
      }
      void activateExaWithType(services, type);
      return;
    }
    try {
      void activateSearchProvider(services, assertSearchProvider(providerArg));
    } catch {
      services.session.notice("warn", `unknown search provider: ${providerArg}`);
    }
    return;
  }
  const active = getConfig().activeSearchProvider;
  const exaType = getExaSearchType();
  const options: PickerOption[] = searchProviderIds.map((id) => {
    const adapter = searchProviders[id];
    const keyNote = adapter?.needsApiKey
      ? `${adapter.displayName} · API key required`
      : `${adapter?.displayName ?? id} · keyless`;
    return {
      value: id,
      label: id === active ? `${id} · active` : id,
      description: id === "exa" ? `${keyNote} · type: ${exaType}` : keyNote,
    };
  });
  services.overlay.openPicker({ title: "Search providers", options }, (value) => {
    void activateSearchProvider(services, assertSearchProvider(value));
  });
}

async function activateSearchProvider(services: AppServices, next: SearchProviderId): Promise<void> {
  const adapter = searchProviders[next];
  if (adapter?.needsApiKey) {
    const current = await getSearchProviderKey(next);
    if (!current.value) {
      services.overlay.close();
      const key = await services.overlay.openSecret({
        title: `${next} search API key`,
        prompt: `No API key is configured for ${adapter.displayName}. Enter it now to use this search provider.`,
      });
      if (!key) return;
      await setSecret("search", next, key);
    }
  }
  setActiveSearchProvider(next);
  services.overlay.close();
  services.session.notice("info", `search provider → ${next}`);
  // Exa is the only provider with a tunable retrieval strategy — offer the
  // type picker right after activation so users land on the right latency
  // and depth without a second command.
  if (next === "exa") openExaSearchTypePicker(services);
}

/** Open the picker that customises Exa's retrieval strategy (`type`). */
function openExaSearchTypePicker(services: AppServices): void {
  const current = getExaSearchType();
  const options: PickerOption[] = exaSearchTypes.map((type) => ({
    value: type,
    label: type === current ? `${type} · active` : type,
    description: exaSearchTypeDescriptions[type],
    active: type === current,
  }));
  services.overlay.openPicker({ title: "Exa search type", options }, (value) => {
    const type = asExaSearchType(value);
    if (type) applyExaSearchType(services, type);
    services.overlay.close();
  });
}

/**
 * Persist the chosen Exa search type. When Exa is not already the active
 * search provider, selecting a type also activates Exa so the setting takes
 * effect on the next search.
 */
async function activateExaWithType(
  services: AppServices,
  type: ExaSearchType,
): Promise<void> {
  if (getConfig().activeSearchProvider !== "exa") {
    await activateSearchProvider(services, "exa");
  }
  applyExaSearchType(services, type);
}

function applyExaSearchType(services: AppServices, type: ExaSearchType): void {
  setExaSearchType(type);
  services.session.notice("info", `exa search type → ${type}`);
}

export function handleReasoning(services: AppServices, invocation: CommandInvocation): void {
  if (invocation.args) {
    applyReasoning(services, invocation.args.trim());
    return;
  }
  const current = getConfig().thinking;
  const provider = services.session.getState().provider ?? getConfig().defaultProvider;
  const model = services.session.getState().model ?? "";
  const supported = modelSupportsThinking(provider, model) ? "supported" : "model may ignore it";
  const options: PickerOption[] = Object.entries(REASONING_DESCRIPTIONS).map(([value, description]) => ({
    value,
    label: value,
    description,
    active: value === (current.enabled ? current.effort : "off"),
  }));
  services.overlay.openPicker({ title: `Reasoning · ${supported}`, options }, (value) => {
    applyReasoning(services, value);
    services.overlay.close();
  });
}

function applyReasoning(services: AppServices, value: string): void {
  const lower = value.toLowerCase();
  if (/^(on|enable|true)$/.test(lower)) {
    setThinking({ enabled: true });
    services.session.notice("info", `thinking → ${getConfig().thinking.effort}`);
    return;
  }
  if (["off", "none", "disable", "false"].includes(lower)) {
    setThinking({ enabled: false });
    services.session.notice("info", "thinking → off");
    return;
  }
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(lower)) {
    setThinking({ enabled: true, effort: lower as ReasoningEffort });
    services.session.notice("info", `thinking → ${lower}`);
    return;
  }
  services.session.notice("warn", "usage: /effort [on|off|minimal|low|medium|high|xhigh|max]");
}

export async function handleHistory(services: AppServices, invocation?: CommandInvocation): Promise<void> {
  const rawArgs = invocation?.args?.trim() ?? "";
  if (rawArgs) {
    const [sub, ...rest] = rawArgs.split(/\s+/);
    const subLower = sub?.toLowerCase() ?? "";
    if (["delete", "remove", "rm", "del"].includes(subLower)) {
      const finalId = rest.join(" ").trim();
      if (!finalId) {
        services.session.notice("warn", "usage: /history delete <session-id>");
        return;
      }
      const result = await deleteSession(finalId);
      services.session.notice(result.deleted ? "info" : "warn", result.deleted ? `deleted ${finalId}` : result.detail);
      return;
    }
  }
  const sessions = await listSessionSummaries(200, { recovery: "background" });
  const currentMessages = services.session.messages;
  const currentId = services.session.sessionId;
  const currentTitle = services.session.getState().title;
  if (sessions.length === 0 && currentMessages.length === 0) {
    services.session.notice(
      "info",
      "no session history yet — chat once and it will appear here with an AI title",
    );
    return;
  }
  // Live session once at the top — never also list the same id below
  // (that looked like two copies of one chat with different item counts).
  const otherSessions = sessions.filter((s) => s.id !== currentId);
  const liveVisualCount = conversationItemCount(
    services.transcript.getState(),
  );
  const options: PickerOption[] = [
    {
      value: "__current__",
      label: currentTitle?.trim() || "Current session",
      description: currentMessages.length
        ? `id ${currentId}  ·  now  ·  ${liveVisualCount} items  ·  ${currentMessages.length} model msgs  ·  this window`
        : `id ${currentId}  ·  now  ·  empty session  ·  this window`,
      active: true,
    },
    ...otherSessions.map((session) => {
      const count = session.itemCount;
      const date = session.updatedAt ?? session.createdAt;
      const when = relativeTime(date) || "some time ago";
      const stamp = date.slice(0, 16).replace("T", " ");
      const where = shortCwd(session.cwd);
      const title =
        (session.name && session.name.trim()) || "Untitled chat";
      // Two-line card: title on top; meta chips underneath (full session id).
      const meta = [
        `id ${session.id}`,
        when,
        stamp,
        `${count} item${count === 1 ? "" : "s"}`,
        where ? `in ${where}` : "",
      ]
        .filter(Boolean)
        .join("  ·  ");
      return {
        value: session.id,
        label: title,
        description: meta,
        active: false,
      };
    }),
  ];
  const liveOptions = [...options];
  const deleteRow = (value: string): void => {
    if (value === "__current__") {
      services.toast.warn("cannot delete the session you are in", {
        key: "history-delete",
      });
      return;
    }
    const index = liveOptions.findIndex((option) => option.value === value);
    if (index === -1) return;
    const label = liveOptions[index]!.label;
    liveOptions.splice(index, 1);
    services.overlay.replacePickerOptions([...liveOptions]);
    services.toast.info(`deleting ${label}…`, { key: "history-delete" });
    void (async () => {
      const result = await purgeSession(value);
      if (result.deleted) {
        services.toast.success(`deleted ${label} · ${result.detail}`, {
          key: "history-delete",
        });
      } else {
        services.toast.error(`could not delete ${label} · ${result.detail}`, {
          key: "history-delete",
        });
      }
    })();
  };
  services.overlay.openPicker(
    {
      title: "History",
      twoLine: true,
      historyStyle: true,
      searchDescription: true,
      rowAction: { chord: "ctrl+x", hint: "^x:delete" },
      options,
    },
    (value) => {
    void (async () => {
      if (value === "__current__") {
        services.session.notice("info", "showing current session");
        services.overlay.close();
        return;
      }
      // Refresh only the selected record so a session changed by another
      // process while the picker was open cannot be resumed stale. This work
      // happens after selection and does not delay opening /history.
      const session = await getSession(value);
      if (!session) {
        services.session.notice("warn", "session not found");
        services.overlay.close();
        return;
      }

      if (session.id === currentId) {
        services.session.notice("info", "already on this session");
        services.overlay.close();
        return;
      }

      // Persist the outgoing live session before rebinding id, so work is not
      // lost and we don't orphan a half-saved row under the old id.
      if (currentMessages.length > 0) {
        try {
          await services.session.persistNow();
        } catch {
          /* best-effort */
        }
      }

      clearActiveProjectRoot();
      services.plan.clear();
      services.session.loadHistory(session.messages, {
        sessionId: session.id,
        title: session.name,
        persistenceRevision: session.revision,
        ...(session.previousTurn
          ? { previousTurn: session.previousTurn }
          : {}),
        ...(session.contextUsage
          ? { contextUsage: session.contextUsage }
          : {}),
        ...(session.workspaceFolder
          ? {
              workspaceFolder: session.workspaceFolder,
              workspaceCode: session.workspaceCode,
            }
          : {}),
      });

      // Prefer the richer of visual transcript vs model messages (tools often
      // survive only in messages after abort-before-save of the UI snapshot).
      const visual = boundSessionVisualInput(
        session.transcript,
        session.messages,
      );
      const hydrated = hydrateSessionVisual(
        visual.transcript,
        visual.messages,
      );
      services.transcript.hydrate(hydrated.state);
      if (visual.omittedItems > 0 || visual.omittedMessages > 0) {
        services.session.notice(
          "info",
          `Loaded recent history view; ${Math.max(visual.omittedItems, visual.omittedMessages)} older item(s) remain available to the model on continue.`,
        );
      }

      // Seed tool output spools so click-to-pager still has bodies.
      for (const [toolCallId, output] of hydrated.toolOutputs) {
        services.session.spool.replace(toolCallId, output);
      }

      // Plans are stored per sessionId (plans.jsonl / sqlite), separate from
      // the chat transcript. Reload them so Ctrl+H / Ctrl+P show the plan
      // that belonged to this resumed session (classic clai parity).
      const plan = await services.plan.load(session.id).catch(() => undefined);
      // Clear approval gate for a resumed plan — user must /implement again
      // if the plan was still draft/approved but execution should not resume
      // silently.
      services.session.setPlanApproved(
        plan?.status === "approved" || plan?.status === "in_progress",
      );

      // Notices are UI-only — exclude from item counts (and they are never
      // model messages; session.messages is already the real LLM history).
      const itemCount = conversationItemCount(hydrated.state);
      const titleBit = session.name
        ? ` · ${session.name.length > 28 ? `${session.name.slice(0, 27)}…` : session.name}`
        : "";
      const planBit = plan ? " · plan" : "";
      const toolCards = [...hydrated.state.byId.values()].filter(
        (i) => i.kind === "tool",
      ).length;
      const incomplete =
        transcriptLooksIncomplete(
          session.transcript?.length ?? 0,
          session.messages,
        ) ||
        (Boolean(plan?.tasks?.length) &&
          toolCards === 0 &&
          (session.transcript?.length ?? 0) < 8);
      // Short toast — full counts were too wide for the chip.
      services.session.notice(
        "info",
        `resumed${titleBit}${planBit} · ${itemCount} items`,
      );
      if (incomplete) {
        services.session.notice(
          "warn",
          plan?.tasks?.length
            ? "thin history · plan OK · /implement to continue"
            : "thin history · some tools may be missing",
        );
      }
      services.overlay.close();
    })();
  },
    deleteRow,
  );
}

export function handlePermissions(services: AppServices, invocation: CommandInvocation): void {
  const apply = (value: "default" | "allow-all") => {
    updateConfig({ permissions: value });
    services.session.notice("info", `permissions → ${value}`);
  };
  if (invocation.args) {
    const value = invocation.args.trim().toLowerCase();
    if (value === "default" || value === "allow-all") apply(value);
    return;
  }
  const current = getConfig().permissions ?? "default";
  services.overlay.openPicker(
    {
      title: "Permissions",
      options: [
        {
          value: "default",
          label: "default",
          description: "confirm risky tool calls",
          active: current === "default",
        },
        {
          value: "allow-all",
          label: "allow-all",
          description: "skip confirmation prompts",
          active: current === "allow-all",
        },
      ],
    },
    (value) => {
      apply(value as "default" | "allow-all");
      services.overlay.close();
    },
  );
}

export function handleOutput(services: AppServices, invocation: CommandInvocation): void {
  const state = services.transcript.getState();
  const toolItems = [...state.byId.values()].filter((item) => item.kind === "tool");
  if (toolItems.length === 0) {
    services.session.notice("info", "no tool output yet");
    return;
  }

  const arg = invocation.args.trim().toLowerCase();
  if (!arg) {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    services.toast.show(
      on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O",
      { key: "output", durationMs: 1500 },
    );
    return;
  }
  if (arg === "list" || arg === "ls") {
    services.overlay.openPicker(
      {
        title: "Tool output",
        options: toolItems.map((item) => ({
          value: item.id,
          label: item.name,
          description: item.argsDisplay,
        })),
      },
      (value) => {
        services.overlay.close();
        const item = toolItems.find((t) => t.id === value);
        if (item) void openToolOutputPager(services, item);
      },
    );
    return;
  }
  const target =
    arg !== "last"
      ? toolItems.find((t) => t.toolCallId === arg || t.id === arg)
      : toolItems.at(-1);
  if (target) void openToolOutputPager(services, target);
  else services.session.notice("info", arg ? `no tool output: ${arg}` : "no tool output yet");
}

export function handlePlanPager(services: AppServices): void {
  void (async () => {
    let plan = services.plan.current();
    if (!plan) {
      plan = await services.plan
        .load(services.session.sessionId)
        .catch(() => undefined);
    }
    if (!plan) {
      services.session.notice("info", "no active plan yet");
      return;
    }
    const { formatPlanPagerDocument } = await import(
      "../rendering/plan-view.js"
    );
    services.overlay.openPager(
      `Plan · ${plan.goal}`,
      formatPlanPagerDocument(plan),
      undefined,
      undefined,
      "force",
    );
  })();
}
