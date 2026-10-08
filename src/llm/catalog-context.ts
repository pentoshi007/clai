import { AsyncLocalStorage } from "node:async_hooks";
import type { CatalogFacts } from "./catalog-facts.js";

const catalogContext = new AsyncLocalStorage<{
  provider: string;
  facts: ReadonlyMap<string, CatalogFacts>;
}>();

export function withModelCatalogFacts<T>(
  provider: string,
  models: readonly { id: string; facts?: CatalogFacts | undefined }[],
  run: () => T,
): T {
  const facts = new Map<string, CatalogFacts>();
  for (const model of models) {
    if (model.facts) facts.set(model.id.trim().toLowerCase(), model.facts);
  }
  return catalogContext.run({ provider, facts }, run);
}

export function scopedModelCatalogFacts(
  provider: string,
): ReadonlyMap<string, CatalogFacts> | undefined {
  const scope = catalogContext.getStore();
  return scope?.provider === provider ? scope.facts : undefined;
}
