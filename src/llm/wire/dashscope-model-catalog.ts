const MODEL_CATALOG_URL = "https://dashscope-intl.aliyuncs.com/api/v1/models";
const MODEL_PAGE_SIZE = 100;
const MODEL_MAX_PAGES = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedModelEntry(value: unknown): Record<string, unknown> | undefined {
  const entry = asRecord(value);
  if (!entry) return undefined;
  const model = typeof entry.model === "string" ? entry.model.trim() : "";
  if (!model) return undefined;
  const info = asRecord(entry.model_info);
  return {
    ...entry,
    id: model,
    ...(info?.context_window !== undefined ? { context_window: info.context_window } : {}),
    ...(info?.max_input_tokens !== undefined ? { max_input_tokens: info.max_input_tokens } : {}),
    ...(info?.max_output_tokens !== undefined ? { max_output_tokens: info.max_output_tokens } : {}),
  };
}

export async function fetchDashScopeModelCatalog(
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (let page = 1; page <= MODEL_MAX_PAGES; page += 1) {
    const url = new URL(MODEL_CATALOG_URL);
    url.searchParams.set("page_no", String(page));
    url.searchParams.set("page_size", String(MODEL_PAGE_SIZE));
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`DashScope model catalog failed: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const output = asRecord(asRecord(body)?.output);
    const batch = Array.isArray(output?.models) ? output.models : [];
    for (const raw of batch) {
      const entry = normalizedModelEntry(raw);
      if (entry) entries.push(entry);
    }
    const total = output?.total;
    if (
      batch.length === 0 ||
      (typeof total === "number" && Number.isFinite(total) && entries.length >= total) ||
      batch.length < MODEL_PAGE_SIZE
    ) {
      break;
    }
  }
  return entries;
}
