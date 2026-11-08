import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { catalogRecord, createCatalogProvider } from "./catalog-provider.js";

export const UNALIGNED_DEFAULT_BASE_URL = "https://api.unaligned.pw/openai/v1";

const OPENAI_FORMAT_SUFFIX = /\/openai\/v1$/i;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function withLimitFields(entry: unknown): unknown {
  const record = catalogRecord(entry);
  if (!record) return entry;
  const context = positiveNumber(record.context);
  const output = positiveNumber(record.max_output);
  if (context === undefined && output === undefined) return entry;
  return {
    ...record,
    ...(context !== undefined && record.context_length === undefined
      ? { context_length: context }
      : {}),
    ...(output !== undefined && record.max_output_tokens === undefined
      ? { max_output_tokens: output }
      : {}),
  };
}

export function unalignedCatalogUrl(baseUrl: string): string {
  return `${baseUrl.replace(OPENAI_FORMAT_SUFFIX, "/v1")}/models`;
}

export function unalignedCatalogEntries(payload: unknown): unknown[] {
  return catalogEntriesFromPayload(payload).map(withLimitFields);
}

const handle = createCatalogProvider({
  id: "unaligned",
  displayName: "Unaligned",
  envVar: "UNALIGNED_API_KEY",
  defaultBaseUrl: UNALIGNED_DEFAULT_BASE_URL,
  keyHelp:
    "Create one in the Unaligned dashboard (keys start with sk-unal-), then run `clai set unaligned <key>`.",
  validateKey: (key) => /^sk-unal-\S{8,}$/.test(key.trim()),
  catalogUrl: unalignedCatalogUrl,
  catalogEntries: unalignedCatalogEntries,
});

export const unalignedProvider = handle.provider;
export const resetUnalignedModelCache = handle.resetModelCatalog;
