import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Unpack } from "tar";

const ORIGINS = new Set(["https://nodejs.org", "https://registry.npmjs.org"]);
const VERSION = /^\d+\.\d+\.\d+$/;
const STALL_TIMEOUT_MS = 60_000;
const PROGRESS_STEP_BYTES = 256 * 1024;

export interface NpmRelease {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

export function officialUrl(value: string): URL {
  const url = new URL(value);
  if (!ORIGINS.has(url.origin) || url.username || url.password) {
    throw new Error(`Refusing unofficial download origin: ${url.origin}`);
  }
  return url;
}

export async function fetchBytes(
  url: string,
  limit: number,
  signal?: AbortSignal,
  onProgress?: (received: number, total?: number) => void,
): Promise<Buffer> {
  const stall = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const watch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => stall.abort(new Error(`Download stalled: no data for ${STALL_TIMEOUT_MS / 1000}s (${url})`)),
      STALL_TIMEOUT_MS,
    );
  };
  watch();
  try {
    const response = await fetch(officialUrl(url), {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
      headers: { "User-Agent": "clai-rea-installer" },
    });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
    const encoding = response.headers.get("content-encoding")?.toLowerCase();
    const declared = Number(response.headers.get("content-length"));
    const length = encoding && encoding !== "identity" ? 0 : declared;
    if (declared > limit) {
      await response.body?.cancel();
      throw new Error(`Download exceeds ${limit} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`Empty download: ${url}`);
    const exact = length > 0 ? Buffer.allocUnsafe(length) : undefined;
    const chunks: Uint8Array[] = [];
    let received = 0;
    let reported = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        watch();
        if (received + value.byteLength > limit) throw new Error(`Download exceeds ${limit} bytes`);
        if (exact) {
          if (received + value.byteLength > exact.byteLength) throw new Error("Download exceeds its declared length");
          exact.set(value, received);
        } else chunks.push(value);
        received += value.byteLength;
        if (received - reported >= PROGRESS_STEP_BYTES) {
          reported = received;
          onProgress?.(received, length > 0 ? length : undefined);
        }
      }
      if (received === 0 || (exact && received !== exact.byteLength)) throw new Error("Incomplete download");
      onProgress?.(received, length > 0 ? length : undefined);
      return exact ?? Buffer.concat(chunks, received);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return JSON.parse((await fetchBytes(url, 4 * 1024 * 1024, signal)).toString("utf8")) as unknown;
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid release metadata");
  return value as Record<string, unknown>;
}

export async function npmRelease(name: "rea-agents" | "npm", tag = "latest", signal?: AbortSignal): Promise<NpmRelease> {
  if (tag !== "latest" && !VERSION.test(tag)) throw new Error("Invalid package version");
  const metadata = jsonObject(await fetchJson(`https://registry.npmjs.org/${name}/${tag}`, signal));
  const dist = jsonObject(metadata.dist);
  if (metadata.name !== name || typeof metadata.version !== "string" || !VERSION.test(metadata.version) ||
      typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
    throw new Error(`Invalid official ${name} release metadata`);
  }
  const url = officialUrl(dist.tarball);
  if (url.origin !== "https://registry.npmjs.org" || !url.pathname.startsWith(`/${name}/-/`)) {
    throw new Error(`Invalid official ${name} package URL`);
  }
  return { name, version: metadata.version, tarball: url.href, integrity: dist.integrity };
}

export function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const match = /^sha(256|512)-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error("A SHA-256 or SHA-512 package checksum is required");
  const actual = createHash(`sha${match[1]}`).update(bytes).digest();
  const expected = Buffer.from(match[2]!, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Downloaded package checksum mismatch");
}

export async function extractPackage(bytes: Buffer, destination: string, archiveRoot: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let total = 0;
  let entries = 0;
  const unpack = new Unpack({
    cwd: destination, strip: 1, strict: true,
    preserveOwner: false, noMtime: true, maxDecompressionRatio: 200,
    filter: (path, entry) => {
      const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/");
      if (parts[0] !== archiveRoot || parts.some((part) => !part || part === ".." || part === "." || /[:\0]/.test(part))) {
        unpack.abort(new Error("Unsafe path in downloaded archive"));
        return false;
      }
      if (!("type" in entry) || (entry.type !== "File" && entry.type !== "Directory")) return false;
      total += entry.size;
      entries += 1;
      if (total > 512 * 1024 * 1024 || entries > 30_000) {
        unpack.abort(new Error("Downloaded archive exceeds extraction limits"));
        return false;
      }
      return true;
    },
  });
  await pipeline(Readable.from([bytes]), unpack);
}
