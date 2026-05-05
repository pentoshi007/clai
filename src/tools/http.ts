import type { ToolResult } from "../types.js";

export async function httpFetch(
  url: string,
  options: {
    method?: string | undefined;
    body?: string | undefined;
    maxBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body ?? null,
  });
  const limit = options.maxBytes ?? 1_000_000;
  const text = await response.text();
  return {
    ok: response.ok,
    output: text.slice(0, limit),
    exitCode: response.status,
  };
}
