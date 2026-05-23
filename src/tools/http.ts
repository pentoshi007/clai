import type { ToolResult } from "../types.js";

export async function httpFetch(
  url: string,
  options: {
    method?: string | undefined;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
    maxBytes?: number | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<ToolResult> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    body: options.body ?? null,
  };
  if (options.headers) {
    init.headers = options.headers;
  }
  const response = await fetch(url, { ...init, signal: options.signal ?? null });
  const limit = options.maxBytes ?? 256_000;
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    while (bytesRead < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - bytesRead;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      bytesRead += value.byteLength;
    }
    if (bytesRead >= limit) truncated = true;
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  const headerPreview = [
    `status=${response.status}`,
    `content-type=${response.headers.get("content-type") ?? "unknown"}`,
    `bytes=${bytesRead}${truncated ? "+" : ""}`,
  ].join(" ");
  return {
    ok: response.ok,
    output: `${headerPreview}\n${text}${truncated ? `\n... response truncated at ${limit} bytes ...` : ""}`,
    exitCode: response.status,
    truncated,
    stats: { bytesRead, bytesShown: bytesRead },
  };
}
