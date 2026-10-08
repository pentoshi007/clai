import { ProviderError } from "../http.js";
import { readBodyCapped } from "../wire/response-errors.js";
import { asRecord, pickString } from "./qoder-auth.js";
import { readQoderResponseBody } from "./qoder-http.js";
import { qoderResponseError } from "./qoder-response.js";

export interface QoderCatalogEntry {
  key: string;
  display_name?: string | undefined;
  is_reasoning?: boolean | undefined;
  is_vl?: boolean | undefined;
  is_free?: boolean | undefined;
  price_factor?: number | undefined;
  max_input_tokens?: number | undefined;
  thinking_config?: {
    enabled?: { efforts?: Record<string, unknown> };
  };
}

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCatalogEntry(value: unknown): QoderCatalogEntry | undefined {
  const entry = asRecord(value);
  const key = entry && pickString(entry, "key");
  if (!entry || !key) return undefined;
  const thinking = asRecord(entry.thinking_config);
  const enabled = asRecord(thinking?.enabled);
  const efforts = asRecord(enabled?.efforts);
  return {
    key,
    display_name: pickString(entry, "display_name"),
    is_reasoning: entry.is_reasoning === true,
    is_vl: entry.is_vl === true,
    is_free: entry.is_free === true,
    price_factor: finiteNumber(entry.price_factor),
    max_input_tokens: finiteNumber(entry.max_input_tokens),
    ...(efforts ? { thinking_config: { enabled: { efforts } } } : {}),
  };
}

export async function readQoderModelCatalog(response: Response, signal?: AbortSignal): Promise<QoderCatalogEntry[]> {
  if (!response.ok) throw qoderResponseError(response.status, await readQoderResponseBody(response, signal));
  const raw = await readBodyCapped(response, MAX_CATALOG_BYTES + 1, signal);
  if (Buffer.byteLength(raw, "utf8") > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError("Qoder model catalog exceeded the 4 MiB response limit.", 502);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ProviderError("Qoder returned malformed model catalog JSON.", 502, raw.slice(0, 2000));
  }
  const chat = asRecord(payload)?.chat;
  if (!Array.isArray(chat)) {
    throw new ProviderError("Qoder returned an invalid model catalog: expected a chat array.", 502, raw.slice(0, 2000));
  }
  const entries: QoderCatalogEntry[] = [];
  for (const value of chat) {
    const entry = parseCatalogEntry(value);
    if (entry) entries.push(entry);
  }
  return entries;
}
