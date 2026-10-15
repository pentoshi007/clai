import { createHash } from "node:crypto";
import {
  getActiveProviderEndpoint,
  getProviderEndpoints,
  providerUsesEndpoints,
} from "../store/config.js";
import { getProviderKeys } from "../store/keys.js";
import type { ProviderId } from "../types.js";
import { ProviderError } from "./http.js";
import { buildKeyAttemptPlan, isKeyRotatableError } from "./key-rotation.js";
import type { ProviderAuth } from "./provider.js";
import { isRetriableError, sleep } from "./routing/error-classification.js";
import { authForSlot } from "./routing/provider-selection.js";
import { getProvider, providerAuth } from "./router.js";

const DISCOVERY_RECOVERY_WINDOW_MS = 15_000;
const RIVER_AUTH_RECHECK_DELAYS_MS = [250, 750, 1_500] as const;
const inFlight = new Map<string, Promise<string[]>>();

function discoveryEndpoints(provider: ProviderId): (string | undefined)[] {
  if (!providerUsesEndpoints(provider)) return [undefined];
  const configured = getProviderEndpoints(provider);
  const active = getActiveProviderEndpoint(provider);
  if (active && !configured.urls.includes(active)) return [active];
  if (configured.urls.length === 0) return [undefined];
  const endpoints = buildKeyAttemptPlan(configured.urls.length, configured.activeIndex)
    .map(index => configured.urls[index]!)
    .filter(url => !(configured.disabledUrls ?? []).includes(url));
  if (endpoints.length === 0)
    throw new Error(`all configured endpoints for ${provider} are disabled`);
  return endpoints;
}

async function discoveryRoutes(provider: ProviderId): Promise<ProviderAuth[]> {
  const endpoints = discoveryEndpoints(provider);
  const multi = await getProviderKeys(provider);
  if (multi.keys.length === 0) return [await providerAuth(provider)];
  const keys = buildKeyAttemptPlan(multi.keys.length, multi.activeIndex)
    .map(index => multi.keys[index]!)
    .filter(key => !key.disabled);
  if (keys.length === 0)
    throw new Error(`all configured API keys for ${provider} are disabled`);
  return endpoints.flatMap(baseUrl => keys.map(key => ({
    ...authForSlot(provider, key.value, key),
    ...(baseUrl ? { baseUrl } : {}),
  })));
}

async function fetchModelRoutes(
  provider: ProviderId,
  routes: readonly ProviderAuth[],
  listModels: (auth: ProviderAuth) => Promise<string[]>,
): Promise<string[]> {
  const deadline = Date.now() + DISCOVERY_RECOVERY_WINDOW_MS;
  let lastError: unknown = new Error("Model discovery recovery deadline exceeded");
  for (const auth of routes) {
    if (Date.now() >= deadline) break;
    try {
      return await listModels(auth);
    } catch (error) {
      if (error instanceof ProviderError && error.retryable === false) throw error;
      if (!isKeyRotatableError(error, isRetriableError)) throw error;
      lastError = error;
    }
  }
  if (provider !== "river") throw lastError;
  for (const delay of RIVER_AUTH_RECHECK_DELAYS_MS) {
    const authRejected = lastError instanceof ProviderError &&
      lastError.status === 401 && lastError.retryable !== false;
    if (!authRejected || Date.now() + delay >= deadline) break;
    await sleep(delay);
    const refreshed = await discoveryRoutes(provider);
    if (Date.now() >= deadline) break;
    try {
      return await listModels(refreshed[0]!);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function listProviderModels(provider: ProviderId): Promise<string[]> {
  const impl = getProvider(provider);
  const listModels = impl.listModels?.bind(impl);
  if (!listModels) return [];
  const routes = await discoveryRoutes(provider);
  const key = createHash("sha256").update(JSON.stringify([provider, routes])).digest("hex");
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = fetchModelRoutes(provider, routes, listModels);
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}
