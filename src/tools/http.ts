import type { ToolResult } from "../types.js";

export async function httpFetch(
  url: string,
  options: {
    method?: string | undefined;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
    maxBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    body: options.body ?? null,
  };
  if (options.headers) {
    init.headers = options.headers;
  }
  const response = await fetch(url, init);
  const limit = options.maxBytes ?? 1_000_000;
  const text = await response.text();
  return {
    ok: response.ok,
    output: text.slice(0, limit),
    exitCode: response.status,
  };
}
