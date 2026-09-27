import type { ProviderId } from "../types.js";
import { getProvider, providerAuth } from "./router.js";

const CATALOG_PREFETCH_TTL_MS = 30 * 60 * 1000;
const CATALOG_PREFETCH_FAILURE_RETRY_MS = 60 * 1000;

const nextPrefetchAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

function isDue(provider: ProviderId, now: number): boolean {
  const next = nextPrefetchAt.get(provider);
  return next === undefined || now >= next;
}

async function fetchCatalog(provider: ProviderId): Promise<void> {
  const impl = getProvider(provider);
  if (!impl.listModels) return;
  const auth = await providerAuth(provider);
  await impl.listModels(auth);
}

export function prefetchProviderCatalog(
  provider: ProviderId | undefined,
  options?: { now?: number } | undefined,
): Promise<void> {
  if (!provider) return Promise.resolve();
  const now = options?.now ?? Date.now();
  const pending = inFlight.get(provider);
  if (pending) return pending;
  if (!isDue(provider, now)) return Promise.resolve();
  nextPrefetchAt.set(provider, now + CATALOG_PREFETCH_TTL_MS);
  const task = fetchCatalog(provider)
    .catch(() => {
      nextPrefetchAt.set(provider, now + CATALOG_PREFETCH_FAILURE_RETRY_MS);
    })
    .then(() => {
      inFlight.delete(provider);
    });
  inFlight.set(provider, task);
  return task;
}

export function resetCatalogPrefetchState(): void {
  nextPrefetchAt.clear();
  inFlight.clear();
}
