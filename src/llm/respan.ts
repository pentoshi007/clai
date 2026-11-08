import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { claudeBreakpointMode } from "./claude-breakpoints.js";
import {
  NON_CHAT_MODEL_ID,
  catalogRecord,
  createCatalogProvider,
} from "./catalog-provider.js";

export const RESPAN_DEFAULT_BASE_URL = "https://gateway.respan.ai/v1";
export const RESPAN_CATALOG_URL = "https://api.respan.ai/api/v1/models";

const TEXT_PRICE_UNIT = "token";

function pricesPerToken(record: Record<string, unknown>): boolean {
  const pricing = catalogRecord(record.pricing);
  return [pricing?.input_price_unit, pricing?.output_price_unit]
    .filter((unit): unit is string => typeof unit === "string")
    .every((unit) => unit === TEXT_PRICE_UNIT);
}

function servesChat(entry: unknown): boolean {
  const record = catalogRecord(entry);
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  if (!record || !id || NON_CHAT_MODEL_ID.test(id)) return false;
  return pricesPerToken(record);
}

export function respanCatalogUrl(baseUrl: string): string {
  return baseUrl === RESPAN_DEFAULT_BASE_URL
    ? RESPAN_CATALOG_URL
    : `${baseUrl}/models`;
}

export function respanCatalogEntries(payload: unknown): unknown[] {
  return catalogEntriesFromPayload(payload).filter(servesChat);
}

const handle = createCatalogProvider({
  id: "respan",
  displayName: "Respan",
  envVar: "RESPAN_API_KEY",
  defaultBaseUrl: RESPAN_DEFAULT_BASE_URL,
  keyHelp:
    "Create a key with Gateway enabled at https://platform.respan.ai/platform/gateway/api-keys, then run `clai set respan <key>`.",
  validateKey: (key) => /^\S{16,}$/.test(key.trim()),
  catalogUrl: respanCatalogUrl,
  catalogEntries: respanCatalogEntries,
  breakpointMode: claudeBreakpointMode,
});

export const respanProvider = handle.provider;
export const resetRespanModelCache = handle.resetModelCatalog;
