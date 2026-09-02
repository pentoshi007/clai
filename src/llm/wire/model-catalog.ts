import type { ProviderId } from "../../types.js";
import { registerModelCatalog } from "../capabilities.js";
import type { CatalogModel } from "../capabilities.js";
import {
  catalogEffortList,
  catalogEntriesFromPayload,
  parseCatalogFacts,
} from "../catalog-facts.js";

export function catalogEntryVision(entry: unknown): boolean | undefined {
  return parseCatalogFacts(entry)?.vision;
}

export function ingestModelCatalogEntries(
  provider: ProviderId,
  entries: readonly unknown[],
): string[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const facts = parseCatalogFacts(entry);
    if (!facts) continue;
    const id = facts.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const reasoning = facts.reasoning?.supported;
    const reasoningEfforts = catalogEffortList(
      facts.reasoning?.supportedEfforts,
    );
    models.push({
      id,
      facts,
      ...(facts.vision === undefined ? {} : { vision: facts.vision }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    });
  }
  if (models.length > 0) registerModelCatalog(provider, models);
  return models.map((model) => model.id).sort();
}

export function ingestOpenAiModelCatalog(
  provider: ProviderId,
  payload: unknown,
): string[] {
  return ingestModelCatalogEntries(
    provider,
    catalogEntriesFromPayload(payload),
  );
}
