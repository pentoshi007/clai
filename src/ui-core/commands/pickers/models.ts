import { clearActiveProjectRoot } from "../../../agent/project-root.js";
import { getKnownModels } from "../../../app/commands/catalog.js";
import type { CommandInvocation } from "../../../app/commands/command.js";
import { getActiveProviderEndpoint, getConfig, getCustomProviders } from "../../../store/config.js";
import { envValue, getProviderSecret } from "../../../store/keys.js";
import { providerIds } from "../../../types.js";
import type { ProviderId } from "../../../types.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { persistSessionModel, resolveModelsForProvider } from "./provider.js";

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
