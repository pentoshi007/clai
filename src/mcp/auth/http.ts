import { McpTransportError, withTimeout } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";

export interface OAuthHttpDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export async function fetchOAuthJson(
  url: string,
  init: RequestInit,
  deps: OAuthHttpDeps,
): Promise<{
  status: number;
  ok: boolean;
  record: Record<string, unknown> | undefined;
}> {
  const target = (deps.validateUrl ?? assertSafeDiscoveryUrl)(url);
  const { signal, dispose } = withTimeout(deps.signal, deps.timeoutMs ?? 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (deps.fetchImpl ?? fetch)(target.toString(), {
      ...init,
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpTransportError(
        "protocol",
        "MCP OAuth endpoint attempted a redirect; use its final URL.",
      );
    }
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > 256 * 1024)
          throw new McpTransportError("too-large", "MCP OAuth document exceeded the size limit.");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    let record: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        record = parsed as Record<string, unknown>;
    } catch {
      record = undefined;
    }
    return { status: response.status, ok: response.ok, record };
  } catch (error) {
    if (signal.aborted)
      throw signal.reason instanceof McpTransportError
        ? signal.reason
        : new McpTransportError("cancelled", "MCP OAuth request cancelled.");
    throw error;
  } finally {
    await reader?.cancel().catch(() => undefined);
    dispose();
  }
}

export function oauthErrorDetail(record: Record<string, unknown> | undefined): string {
  const detail = record?.error_description ?? record?.error;
  return typeof detail === "string" ? `: ${detail.slice(0, 200)}` : "";
}
