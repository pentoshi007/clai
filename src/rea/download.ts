import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_REDIRECTS = 5;
const STALL_TIMEOUT_MS = 60_000;
const PROGRESS_STEP_BYTES = 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  readonly hosts: readonly string[];
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: FetchFunction | undefined;
  readonly stallMs?: number | undefined;
}

export interface DownloadOptions extends RequestOptions {
  readonly sha256?: string | undefined;
  readonly bytes?: number | undefined;
  readonly onProgress?: ((received: number, total?: number) => void) | undefined;
}

export interface DownloadResult {
  readonly bytes: number;
  readonly sha256: string;
}

export function allowedHost(url: URL, hosts: readonly string[]): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return hosts.some((host) => host.startsWith("*.") ? url.hostname.endsWith(host.slice(1)) : url.hostname === host);
}

function checkedUrl(value: string, hosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Refusing malformed download URL: ${value.slice(0, 80)}`);
  }
  if (!allowedHost(url, hosts)) throw new Error(`Refusing unofficial download origin: ${url.origin}`);
  return url;
}

async function open(url: string, options: RequestOptions, signal: AbortSignal): Promise<Response> {
  const request = options.fetch ?? fetch;
  let current = checkedUrl(url, options.hosts);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await request(current.href, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": "clai-rea-installer", ...options.headers },
    });
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new Error(`Download redirect without a location (${current.origin})`);
    current = checkedUrl(new URL(location, current).href, options.hosts);
  }
  throw new Error(`Download redirected more than ${MAX_REDIRECTS} times`);
}

function stallGuard(options: RequestOptions): { signal: AbortSignal; touch: () => void; stop: () => void } {
  const stall = new AbortController();
  const limit = options.stallMs ?? STALL_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error(`Download stalled: no data for ${Math.round(limit / 1000)}s`)), limit);
  };
  touch();
  return {
    signal: options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal,
    touch,
    stop: () => clearTimeout(timer),
  };
}

function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Download cancelled");
}

async function* chunksOf(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const onAbort = (): void => {
    reader.cancel(cancelled(signal)).catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw cancelled(signal);
      if (done) return;
      yield value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }
}

function requestFailure(response: Response, host: string): string {
  const base = `Request failed: HTTP ${response.status} (${host})`;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(response.headers.get("retry-after"));
  const limited = response.status === 429 || ((response.status === 403 || response.status === 503) && (remaining === "0" || retryAfter > 0));
  if (!limited) return base;
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : undefined;
  const minutes = seconds === undefined ? undefined : Math.max(1, Math.ceil(seconds / 60));
  return `${base}: ${host} is rate limiting this network${minutes === undefined ? "" : `; try again in about ${minutes} minute${minutes === 1 ? "" : "s"}`}`;
}

export async function fetchText(url: string, options: RequestOptions): Promise<string> {
  const guard = stallGuard(options);
  try {
    const response = await open(url, options, guard.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(requestFailure(response, new URL(url).hostname));
    }
    if (!response.body) throw new Error("Empty response");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of chunksOf(response.body, guard.signal)) {
      guard.touch();
      received += chunk.byteLength;
      if (received > options.maxBytes) throw new Error(`Response exceeds ${options.maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, received).toString("utf8");
  } finally {
    guard.stop();
  }
}

export async function fetchJsonValue(url: string, options: RequestOptions): Promise<unknown> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Release metadata is not valid JSON");
  }
}

export async function downloadFile(url: string, destination: string, options: DownloadOptions): Promise<DownloadResult> {
  const expected = options.sha256?.toLowerCase();
  if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) throw new Error("A SHA-256 checksum is required for downloads");
  const guard = stallGuard(options);
  const partial = `${destination}.part`;
  try {
    await rm(partial, { force: true });
    const response = await open(url, options, guard.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed: HTTP ${response.status} (${new URL(url).hostname})`);
    }
    const encoding = response.headers.get("content-encoding")?.toLowerCase();
    const declared = encoding && encoding !== "identity" ? 0 : Number(response.headers.get("content-length"));
    const total = options.bytes ?? (Number.isFinite(declared) && declared > 0 ? declared : undefined);
    const refuse = async (message: string): Promise<never> => {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(message);
    };
    if ((total ?? 0) > options.maxBytes) await refuse(`Download exceeds ${options.maxBytes} bytes`);
    if (options.bytes !== undefined && declared > 0 && declared !== options.bytes) {
      await refuse(`Download size ${declared} does not match the published size ${options.bytes}`);
    }
    if (!response.body) throw new Error("Empty download");
    const hash = createHash("sha256");
    let received = 0;
    let reported = 0;
    async function* counted(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunksOf(body, guard.signal)) {
        guard.touch();
        received += chunk.byteLength;
        if (received > options.maxBytes || (total !== undefined && received > total)) {
          throw new Error(`Download exceeds ${total ?? options.maxBytes} bytes`);
        }
        hash.update(chunk);
        if (received - reported >= PROGRESS_STEP_BYTES) {
          reported = received;
          options.onProgress?.(received, total);
        }
        yield chunk;
      }
    }
    await pipeline(Readable.from(counted(response.body)), createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal: guard.signal });
    if (received === 0 || (total !== undefined && received !== total)) throw new Error("Incomplete download");
    const digest = hash.digest("hex");
    if (expected !== undefined && digest !== expected) throw new Error("Downloaded file checksum mismatch");
    options.onProgress?.(received, total);
    await rename(partial, destination);
    return { bytes: received, sha256: digest };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw guard.signal.aborted && guard.signal.reason instanceof Error ? guard.signal.reason : error;
  } finally {
    guard.stop();
  }
}
