import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const RTK_REPO = "rtk-ai/rtk";
export const RTK_GITHUB = `https://github.com/${RTK_REPO}`;
export const RTK_RELEASES = `${RTK_GITHUB}/releases`;
export const RTK_MARKER = "rtk-ai";
export const RTK_MIN_MINOR = 23;
export const RTK_SUPPORTED = `rtk-ai/rtk ≥ 0.${RTK_MIN_MINOR}`;

const USER_AGENT = "clai-rtk-installer";
const PROBE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

export type RtkOperatingSystem = "darwin" | "linux" | "windows";
export type RtkMachine = "x86_64" | "aarch64";

export interface RtkTarget {
  readonly os: RtkOperatingSystem;
  readonly machine: RtkMachine;
  readonly asset: string;
}

const ASSETS: Record<RtkOperatingSystem, Partial<Record<RtkMachine, string>>> = {
  darwin: {
    x86_64: "rtk-x86_64-apple-darwin.tar.gz",
    aarch64: "rtk-aarch64-apple-darwin.tar.gz",
  },
  linux: {
    x86_64: "rtk-x86_64-unknown-linux-musl.tar.gz",
    aarch64: "rtk-aarch64-unknown-linux-gnu.tar.gz",
  },
  windows: {
    x86_64: "rtk-x86_64-pc-windows-msvc.zip",
  },
};

export const operatingSystem = (platform: NodeJS.Platform): RtkOperatingSystem | undefined =>
  platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;

export const machineOf = (arch: string): RtkMachine | undefined =>
  arch === "x64" || arch === "x86_64" || arch === "amd64"
    ? "x86_64"
    : arch === "arm64" || arch === "aarch64"
      ? "aarch64"
      : undefined;

export const currentTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RtkTarget | undefined => {
  const os = operatingSystem(platform);
  const machine = machineOf(arch);
  if (!os || !machine) return undefined;
  const asset = ASSETS[os][machine];
  return asset ? { os, machine, asset } : undefined;
};

export const describeTarget = (target: RtkTarget): string => `${target.os}/${target.machine}`;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

export const parseSemver = (raw: string | undefined): Semver | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec((raw ?? "").trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
};

export const compareSemver = (left: string, right: string): number | undefined => {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
};

export const meetsMinimum = (version: string | undefined): boolean => {
  const parsed = parseSemver(version);
  return parsed !== undefined && parsed.minor >= RTK_MIN_MINOR;
};

export class RtkNetworkError extends Error {
  readonly rateLimited: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { rateLimited?: boolean; status?: number } = {}) {
    super(message);
    this.name = "RtkNetworkError";
    this.rateLimited = options.rateLimited === true;
    this.status = options.status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const rateLimited = (status: number, headers: Headers): boolean =>
  status === 429 || headers.get("x-ratelimit-remaining") === "0";

const backoffMs = (headers: Headers, attempt: number): number => {
  const retryAfter = Number.parseInt(headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1_000, 20_000);
  const reset = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1_000 - Date.now();
    if (wait > 0) return Math.min(wait, 20_000);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), 8_000);
};

interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
}

const httpGet = async (
  url: string,
  timeoutMs: number,
  accept: string,
  redirect: RequestRedirect = "follow",
): Promise<HttpResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: accept },
    });
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    clearTimeout(timer);
  }
};

const describeFailure = (error: unknown, url: string): string => {
  if (error instanceof RtkNetworkError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return `timed out contacting ${url}`;
  return error instanceof Error ? error.message : String(error);
};

export const fetchText = async (
  url: string,
  options: { accept?: string; timeoutMs?: number; onAttempt?: (attempt: number) => void } = {},
): Promise<string> => {
  const accept = options.accept ?? "text/plain";
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let last = `could not reach ${url}`;
  let wasRateLimited = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    options.onAttempt?.(attempt);
    try {
      const response = await httpGet(url, timeoutMs, accept);
      if (response.status === 200) return response.body.toString("utf8");
      if (response.status === 404) {
        throw new RtkNetworkError(`not found (HTTP 404): ${url}`, { status: 404 });
      }
      if (rateLimited(response.status, response.headers)) {
        wasRateLimited = true;
        last = `GitHub rate limit reached (HTTP ${response.status})`;
      } else if (response.status >= 500) {
        last = `server error (HTTP ${response.status}) from ${url}`;
      } else {
        throw new RtkNetworkError(`unexpected HTTP ${response.status} from ${url}`, {
          status: response.status,
        });
      }
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(response.headers, attempt));
    } catch (error) {
      if (error instanceof RtkNetworkError && error.status === 404) throw error;
      last = describeFailure(error, url);
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw new RtkNetworkError(last, { rateLimited: wasRateLimited });
};

const tagFromLocation = (location: string | null): string | undefined =>
  /\/releases\/tag\/(v?\d[^/?#]*)/.exec(location ?? "")?.[1];

const tagFromJson = (json: string): string | undefined =>
  /"tag_name"\s*:\s*"([^"]+)"/.exec(json)?.[1];

export const resolveLatestTag = async (onAttempt?: (attempt: number) => void): Promise<string> => {
  try {
    const probe = await httpGet(`${RTK_RELEASES}/latest`, PROBE_TIMEOUT_MS, "text/html", "manual");
    const tag = probe.status >= 300 && probe.status < 400 ? tagFromLocation(probe.headers.get("location")) : undefined;
    if (tag) return tag;
  } catch {
  }
  const json = await fetchText(`https://api.github.com/repos/${RTK_REPO}/releases/latest`, {
    accept: "application/vnd.github+json",
    ...(onAttempt ? { onAttempt } : {}),
  });
  const tag = tagFromJson(json);
  if (!tag) throw new RtkNetworkError("could not read the latest rtk release from GitHub");
  return tag;
};

export const parseChecksums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(raw.trim());
    if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
};

export interface ReleaseInfo {
  readonly version: string;
  readonly tag: string;
  readonly checksums: ReadonlyMap<string, string>;
}

export const assetUrl = (tag: string, asset: string): string => `${RTK_RELEASES}/download/${tag}/${asset}`;

export const releaseForTag = async (
  tag: string,
  onAttempt?: (attempt: number) => void,
): Promise<ReleaseInfo> => {
  const checksumsText = await fetchText(assetUrl(tag, "checksums.txt"), {
    ...(onAttempt ? { onAttempt } : {}),
  });
  const checksums = parseChecksums(checksumsText);
  if (checksums.size === 0) {
    throw new RtkNetworkError(`release ${tag} published no usable checksums — refusing to install unverified`);
  }
  return { version: tag.replace(/^v/, ""), tag, checksums };
};

export const sha256Hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

export interface ChecksumVerdict {
  readonly ok: boolean;
  readonly actual: string;
  readonly expected?: string;
  readonly reason?: string;
}

export const verifyChecksum = (
  data: Buffer,
  filename: string,
  checksums: ReadonlyMap<string, string>,
): ChecksumVerdict => {
  const expected = checksums.get(filename);
  const actual = sha256Hex(data);
  if (!expected) {
    return { ok: false, actual, reason: `no published checksum for ${filename} — refusing to install` };
  }
  if (expected !== actual) {
    return {
      ok: false,
      actual,
      expected,
      reason: `checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    };
  }
  return { ok: true, actual, expected };
};

export const installDir = (): string => {
  const override = process.env.RTK_INSTALL_DIR?.trim();
  return override && isAbsolute(override) ? override : join(homedir(), ".local", "bin");
};

export const pathContains = (dir: string, pathValue: string = process.env.PATH ?? ""): boolean => {
  const want = resolve(dir);
  const fold = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => fold(resolve(entry)) === fold(want));
};

export const manualInstructions = (target: RtkTarget | undefined): string => {
  const binary = target
    ? `download ${target.asset} from ${RTK_RELEASES}/latest, extract it, and put \`rtk\` on your PATH`
    : `download the ${RTK_RELEASES}/latest asset for your platform, extract it, and put \`rtk\` on your PATH`;
  return [
    `install rtk manually (${RTK_SUPPORTED}):`,
    `  • Homebrew: brew install rtk`,
    `  • Cargo:    cargo install --git ${RTK_GITHUB}`,
    `  • Binary:   ${binary}`,
  ].join("\n");
};
