
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { processAlive } from "./process-tree.js";

export type ProcessIdentityComparison = "match" | "mismatch" | "gone" | "unknown";

export interface ProcessIdentityProvider {
  readonly platform: NodeJS.Platform | "test";
  capture(pid: number): string | undefined;
  captureAsync?(pid: number): Promise<string | undefined>;
}

const IDENTITY_TTL_MS = 15_000;
const IDENTITY_CACHE_MAX = 512;
const PROBE_TIMEOUT_MS = 2_000;

function hashEvidence(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function readLinuxProcessStart(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = raw.lastIndexOf(")");
    if (commEnd < 0) return undefined;
    const fields = raw.slice(commEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && startTime.length > 0 ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function readPsProcessStart(pid: number): string | undefined {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readWindowsProcessStart(pid: number): string | undefined {
  const query =
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`;
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    try {
      const raw = execFileSync(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", query],
        {
          encoding: "utf8",
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (raw.length > 0) return raw;
    } catch {
    }
  }
  return undefined;
}

function readProcessStartAsync(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024,
    }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}

export const defaultProcessIdentityProvider: ProcessIdentityProvider = {
  platform: process.platform,
  capture(pid) {
    if (process.platform === "linux") return readLinuxProcessStart(pid);
    if (process.platform === "win32") return readWindowsProcessStart(pid);
    return readPsProcessStart(pid);
  },
  async captureAsync(pid) {
    if (process.platform === "linux") return readLinuxProcessStart(pid);
    if (process.platform !== "win32") {
      return await readProcessStartAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    }
    const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`;
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const raw = await readProcessStartAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", query]);
      if (raw) return raw;
    }
    return undefined;
  },
};

export class ProcessIdentityTracker {
  private readonly cache = new Map<number, { value: string | undefined; at: number }>();
  private readonly pending = new Map<number, Promise<string | undefined>>();

  constructor(
    private readonly provider: ProcessIdentityProvider = defaultProcessIdentityProvider,
    private readonly now: () => number = Date.now,
    private readonly alive: (pid: number | undefined) => boolean = processAlive,
  ) {}

  capture(pid: number | undefined, options: { refresh?: boolean } = {}): string | undefined {
    if (!pid || pid <= 0) return undefined;
    const now = this.now();
    const cached = this.cache.get(pid);
    if (cached && !options.refresh && now - cached.at < IDENTITY_TTL_MS) {
      return cached.value;
    }
    const raw = this.provider.capture(pid);
    const value = raw ? hashEvidence(raw) : undefined;
    this.cache.set(pid, { value, at: now });
    this.prune(now);
    return value;
  }

  async captureAsync(pid: number | undefined, options: { refresh?: boolean } = {}): Promise<string | undefined> {
    if (!pid || pid <= 0) return undefined;
    const cached = this.cache.get(pid);
    if (cached && !options.refresh && this.now() - cached.at < IDENTITY_TTL_MS) return cached.value;
    const existing = this.pending.get(pid);
    if (existing) return await existing;
    const pending = Promise.resolve().then(() => this.provider.captureAsync
      ? this.provider.captureAsync(pid)
      : this.provider.capture(pid)).then((raw) => {
      const value = raw ? hashEvidence(raw) : undefined;
      if (this.pending.get(pid) === pending) {
        const now = this.now();
        this.cache.set(pid, { value, at: now });
        this.prune(now);
      }
      return value;
    }).finally(() => {
      if (this.pending.get(pid) === pending) this.pending.delete(pid);
    });
    this.pending.set(pid, pending);
    return await pending;
  }

  async compareAsync(
    pid: number | undefined,
    expected: string | undefined,
    options: { refresh?: boolean } = {},
  ): Promise<ProcessIdentityComparison> {
    if (!pid || pid <= 0 || !this.alive(pid)) return "gone";
    const current = await this.captureAsync(pid, { refresh: options.refresh ?? true });
    if (!current || !expected) return "unknown";
    return current === expected ? "match" : "mismatch";
  }

  compare(
    pid: number | undefined,
    expected: string | undefined,
  ): ProcessIdentityComparison {
    if (!pid || pid <= 0) return "gone";
    if (!this.alive(pid)) return "gone";
    const current = this.capture(pid, { refresh: true });
    if (!current || !expected) return "unknown";
    return current === expected ? "match" : "mismatch";
  }

  forget(pid: number | undefined): void {
    if (!pid) return;
    this.cache.delete(pid);
    this.pending.delete(pid);
  }

  private prune(now: number): void {
    if (this.cache.size <= IDENTITY_CACHE_MAX) return;
    for (const [pid, entry] of this.cache) {
      if (now - entry.at >= IDENTITY_TTL_MS) this.cache.delete(pid);
    }
    if (this.cache.size > IDENTITY_CACHE_MAX) this.cache.clear();
  }
}

export const processIdentityTracker = new ProcessIdentityTracker();

export function processIdentity(
  pid: number | undefined,
  options: { refresh?: boolean } = {},
): string | undefined {
  if (process.platform === "win32") return undefined;
  return processIdentityTracker.capture(pid, options);
}

export function forgetProcessIdentity(pid: number | undefined): void {
  processIdentityTracker.forget(pid);
}
