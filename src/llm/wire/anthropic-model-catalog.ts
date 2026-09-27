const MODEL_MAX_PAGES = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function fetchAnthropicModelEntries(
  baseUrl: string,
  headers: HeadersInit,
): Promise<unknown[]> {
  const entries: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MODEL_MAX_PAGES; page += 1) {
    const url = new URL(`${baseUrl}/models`);
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) throw new Error(`Failed to list Anthropic models: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const pageData = asRecord(body);
    if (Array.isArray(pageData?.data)) entries.push(...pageData.data);
    const lastId = typeof pageData?.last_id === "string" ? pageData.last_id : "";
    if (pageData?.has_more !== true || !lastId || seenCursors.has(lastId)) break;
    seenCursors.add(lastId);
    cursor = lastId;
  }

  return entries;
}
