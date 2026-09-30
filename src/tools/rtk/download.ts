import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RtkDownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes?: number | undefined;
}

export interface RtkDownloadOptions {
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly attempts?: number;
  readonly onProgress?: (progress: RtkDownloadProgress) => void;
  readonly signal?: AbortSignal | undefined;
}

export class RtkDownloadError extends Error {
  readonly status: number | undefined;
  readonly rateLimited: boolean;

  constructor(message: string, options: { status?: number; rateLimited?: boolean } = {}) {
    super(message);
    this.name = "RtkDownloadError";
    this.status = options.status;
    this.rateLimited = options.rateLimited === true;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 8_000;
const USER_AGENT = "clai-rtk-installer";

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done, fail) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      done();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      fail(new RtkDownloadError("download cancelled"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      fail(new RtkDownloadError("download cancelled"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const totalFromHeader = (value: string | null): number | undefined => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const retryDelay = (headers: Headers, attempt: number): number => {
  const retryAfter = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 20_000);
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
};

const rateLimited = (status: number, headers: Headers): boolean =>
  status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0");

const describe = (error: unknown, url: string): string => {
  if (error instanceof RtkDownloadError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return `download timed out (${url})`;
  return error instanceof Error ? error.message : String(error);
};

interface AttemptResult {
  readonly bytes: number;
  readonly outcome: "ok" | "retry" | "abort";
  readonly message?: string;
  readonly status?: number;
  readonly rateLimited?: boolean;
}

const streamToFile = async (
  response: Response,
  file: string,
  options: RtkDownloadOptions,
  transfer: AbortController,
): Promise<AttemptResult> => {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalBytes = totalFromHeader(response.headers.get("content-length"));
  let stalled = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      stalled = true;
      transfer.abort();
    }, idleTimeoutMs);
  };
  const out = createWriteStream(file);
  let received = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) return { bytes: 0, outcome: "retry", message: "empty response body" };
    options.onProgress?.({ receivedBytes: 0, ...(totalBytes !== undefined ? { totalBytes } : {}) });
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      armIdle();
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
      received += value.byteLength;
      options.onProgress?.({ receivedBytes: received, ...(totalBytes !== undefined ? { totalBytes } : {}) });
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    out.destroy();
    if (options.signal?.aborted) return { bytes: received, outcome: "abort", message: "download cancelled" };
    if (stalled) {
      return { bytes: received, outcome: "retry", message: `stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s` };
    }
    return { bytes: received, outcome: "retry", message: describe(error, "") };
  } finally {
    clearTimeout(idle);
  }
  if (totalBytes !== undefined && received < totalBytes) {
    return {
      bytes: received,
      outcome: "retry",
      message: `partial download — got ${received} of ${totalBytes} bytes`,
    };
  }
  return { bytes: received, outcome: "ok" };
};

const attemptOnce = async (
  url: string,
  file: string,
  options: RtkDownloadOptions,
): Promise<AttemptResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
    });
    if (!response.ok) {
      const limited = rateLimited(response.status, response.headers);
      const message = limited
        ? `GitHub rate limit reached (HTTP ${response.status})`
        : `download failed (HTTP ${response.status}) for ${url}`;
      const retryable = limited || response.status >= 500 || response.status === 408;
      return {
        bytes: 0,
        outcome: retryable ? "retry" : "abort",
        message,
        status: response.status,
        rateLimited: limited,
      };
    }
    if (options.signal?.aborted) return { bytes: 0, outcome: "abort", message: "download cancelled" };
    return await streamToFile(response, file, options, controller);
  } catch (error) {
    if (options.signal?.aborted) return { bytes: 0, outcome: "abort", message: "download cancelled" };
    return { bytes: 0, outcome: "retry", message: describe(error, url) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
};

export const downloadToFile = async (
  url: string,
  file: string,
  options: RtkDownloadOptions = {},
): Promise<void> => {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  await mkdir(dirname(file), { recursive: true });
  let last = "download failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(file, { force: true }).catch(() => undefined);
    const result = await attemptOnce(url, file, options);
    if (result.outcome === "ok") {
      const size = (await stat(file).catch(() => undefined))?.size ?? result.bytes;
      if (size === 0) {
        last = "downloaded an empty file";
      } else {
        return;
      }
    } else if (result.outcome === "abort") {
      await rm(file, { force: true }).catch(() => undefined);
      throw new RtkDownloadError(result.message ?? "download cancelled", {
        ...(result.status !== undefined ? { status: result.status } : {}),
        ...(result.rateLimited ? { rateLimited: true } : {}),
      });
    } else {
      last = result.message ?? last;
    }
    if (attempt < attempts) await sleep(retryDelay(new Headers(), attempt), options.signal);
  }
  await rm(file, { force: true }).catch(() => undefined);
  throw new RtkDownloadError(last);
};

export const downloadBytes = async (
  url: string,
  options: RtkDownloadOptions = {},
): Promise<Buffer> => {
  const file = join(
    (await import("node:os")).tmpdir(),
    `clai-rtk-${process.pid}-${Date.now()}.bin`,
  );
  try {
    await downloadToFile(url, file, options);
    const { readFile } = await import("node:fs/promises");
    return await readFile(file);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
};
