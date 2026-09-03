
import { getProvider, providerAuth } from "../../llm/router.js";
import { defaultModels, normalizeEndpointUrl } from "../../llm/provider.js";
import { assertProvider } from "../../llm/provider.js";
import { providerIds, type ProviderId } from "../../types.js";
import { getKnownModels } from "../../app/commands/catalog.js";
import { clearActiveProjectRoot } from "../../agent/project-root.js";
import { appendProviderEndpoint, getActiveProviderEndpoint, getCustomProviders, getConfig, getProviderModel } from "../../store/config.js";
import { saveSessionModel } from "../../store/session-model.js";
import { envValue, getProviderSecret, setProviderSecret } from "../../store/keys.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import { addCustomProviderFlow, removeCustomProviderFlow } from "./pickers/custom-provider.js";
export { handleReasoning, handleSearch } from "./pickers/search-reasoning.js";
export { handleOutput, handlePermissions, handlePlanPager } from "./pickers/output-pager.js";
export { handleHistory } from "./pickers/history.js";

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

  if (currentModel && !models.includes(currentModel) && currentModel === getProviderModel(provider)) {
    const isFreeModel = currentModel.startsWith("free-1/") || currentModel.startsWith("free-2/");
    if (!(isFreeModel && provider !== "free")) {
      models = [currentModel, ...models];
    }
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

  const currentModel = state.model ?? getProviderModel(provider);
  const fetchingToastId = services.toast.info(`fetching ${provider} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  const { models, source, error } = await resolveModelsForProvider(provider, currentModel);
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
        active: value === currentModel,
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

function persistSessionModel(
  services: AppServices,
  provider: ProviderId,
  model: string,
): Promise<void> {
  return saveSessionModel(services.session.sessionId, {
    provider,
    model,
    thinking: { ...getConfig().thinking },
  });
}

async function switchToCatalogEntry(
  services: AppServices,
  entry: CatalogEntry,
): Promise<void> {
  const state = services.session.getState();
  const current = state.provider ?? getConfig().defaultProvider;
  if (entry.provider !== current) {
    services.session.setProvider(entry.provider);
    clearActiveProjectRoot();
  }
  services.session.setModel(entry.model);
  await persistSessionModel(services, entry.provider, entry.model);
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
  void persistSessionModel(services, provider, next).catch(() => undefined);
  services.session.notice("info", `model → ${next}`);
}

const ADD_CUSTOM_PROVIDER = "__add_custom_provider__";

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
    const { getCustomProviders } = await import("../../store/config.js");
    const custom = getCustomProviders();
    const options: PickerOption[] = [
      {
        value: ADD_CUSTOM_PROVIDER,
        label: "+ Add custom provider",
        description: "connect an OpenAI-compatible endpoint not listed above",
      },
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
        searchDescription: false,
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
  let model = getProviderModel(next);
  const isFreeModel = model.startsWith("free-1/") || model.startsWith("free-2/");
  if (isFreeModel && next !== "free") {
    model = defaultModels[next];
  }
  services.session.setProvider(next);
  services.session.setModel(model);
  await persistSessionModel(services, next, model);
  services.overlay.close();
  services.session.notice("info", `provider → ${next} · model → ${model}`);
  const fetchingToastId = services.toast.info(`fetching ${next} models…`, {
    key: "model-fetch",
    sticky: true,
  });
  const { models, source, error } = await resolveModelsForProvider(next, model);
  services.toast.dismiss(fetchingToastId);
  if (error) {
    services.session.notice(
      "warn",
      `could not refresh ${next} models: ${error} · showing known models`,
    );
  } else if (source === "known" && getProvider(next).listModels) {
    services.session.notice(
      "warn",
      `${next} model list empty from API · showing known models`,
    );
  } else if (source === "live") {
    services.session.notice("info", `${next} · ${models.length} models (live)`);
  }
  if (models.length === 0) {
    services.session.notice(
      "info",
      `no models for ${next} — type /model <name> to set one manually`,
    );
    return;
  }
  services.overlay.openPicker(
    {
      title: `Models · ${next}${source === "live" ? " · live" : ""}`,
      options: models.map((value) => ({
        value,
        label: value,
        active: value === model,
      })),
    },
    (value) => {
      applyModel(services, next, value, models);
      services.overlay.close();
    },
  );
}

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
