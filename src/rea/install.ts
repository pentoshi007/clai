import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withMcpStorageLock } from "../mcp/storage-lock.js";
import { McpTransportError } from "../mcp/transport.js";
import { getDataDir } from "../store/paths.js";
import { fetchBytes, jsonObject, npmRelease, verifyIntegrity } from "./distribution.js";
import { resolveReaNode, runReaNode } from "./node.js";
import type { ReaInstallation, ReaInstallOptions, ReaMaintenanceAction, ReaMaintenanceResult, ReaProgress, ReaStatus } from "./types.js";

interface Maintenance {
  readonly action: ReaMaintenanceAction;
  readonly promise: Promise<ReaMaintenanceResult>;
  progress?: ReaProgress;
}

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLISH_ATTEMPTS = 8;
const operations = new Map<string, Maintenance>();
const listeners = new Set<(root: string, progress: ReaProgress) => void>();
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): string => error instanceof McpTransportError && error.kind === "timeout"
  ? "Another clai session is installing or updating REA. Wait for it to finish, then check /rea status."
  : describe(error);

export const reaRoot = (): string => resolve(getDataDir(), "tools", "rea");

export function reaMaintenance(root = reaRoot()): { action: ReaMaintenanceAction; progress?: ReaProgress } | undefined {
  const current = operations.get(root);
  return current ? { action: current.action, ...(current.progress ? { progress: current.progress } : {}) } : undefined;
}

export function subscribeReaProgress(listener: (root: string, progress: ReaProgress) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function inside(parent: string, path: string): boolean {
  const local = relative(parent, path);
  return local !== "" && !isAbsolute(local) && local !== ".." && !local.startsWith("../") && !local.startsWith("..\\");
}

export async function detectRea(root = reaRoot(), verify = false): Promise<ReaStatus> {
  let text: string;
  try {
    text = await readFile(join(root, "current.json"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "broken", reason: describe(error) };
  }
  try {
    const data = jsonObject(JSON.parse(text) as unknown);
    const { version, node, entry, directory } = data;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) ||
        typeof node !== "string" || !isAbsolute(node) || typeof entry !== "string" ||
        typeof directory !== "string" || !inside(join(root, "versions"), directory) || !inside(directory, entry)) {
      throw new Error("Invalid managed REA installation record");
    }
    const installation: ReaInstallation = { version, node, entry, directory };
    await Promise.all([access(node), access(entry)]);
    if (verify) await verifyInstallation(installation);
    return { state: "ready", installation };
  } catch (error) {
    return { state: "broken", reason: `${describe(error)} · repair with /rea install` };
  }
}

async function publish(pointer: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(pointer, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sharing = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !sharing || attempt >= PUBLISH_ATTEMPTS) throw error;
      await delay(Math.min(25 * 2 ** attempt, 200));
    }
  }
}

async function pruneVersions(root: string, keep: readonly string[]): Promise<void> {
  const versions = join(root, "versions");
  const entries = await readdir(versions, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  await Promise.all(entries.map(async (entry) => {
    const directory = join(versions, entry.name);
    if (!entry.isDirectory() || keep.includes(directory)) return;
    const info = await stat(directory).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }));
}

async function verifyInstallation(installation: ReaInstallation, signal?: AbortSignal): Promise<void> {
  const reported = await runReaNode(installation.node, [installation.entry, "--version"], {
    ...(signal ? { signal } : {}), timeout: 30_000,
  });
  if (!new RegExp(`(?:^|\\s)${installation.version.replace(/\./g, "\\.")}(?:$|\\s)`).test(reported)) {
    throw new Error(`REA version verification failed: expected ${installation.version}, got ${reported.slice(0, 200)}`);
  }
}

async function install(action: ReaMaintenanceAction, root: string, options: ReaInstallOptions): Promise<ReaMaintenanceResult> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const before = await detectRea(root, true);
  if (action === "install" && before.state === "ready") return { ok: true, installation: before.installation, changed: false };
  onProgress?.({ phase: "resolving", message: "Checking the latest official REA release" });
  const release = await npmRelease("rea-agents", "latest", signal);
  if (before.state === "ready" && before.installation.version === release.version) {
    return { ok: true, installation: before.installation, changed: false };
  }
  const versions = join(root, "versions");
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(versions, `${release.version}-`));
  const pointer = join(root, `current-${randomUUID()}.json`);
  let published = false;
  try {
    const runtime = await resolveReaNode(join(directory, "runtime"), options);
    signal?.throwIfAborted();
    onProgress?.({ phase: "downloading", message: `Downloading REA ${release.version}` });
    const bytes = await fetchBytes(release.tarball, 64 * 1024 * 1024, signal, (receivedBytes, totalBytes) => {
      onProgress?.({ phase: "downloading", message: `Downloading REA ${release.version}`, receivedBytes, ...(totalBytes ? { totalBytes } : {}) });
    });
    verifyIntegrity(bytes, release.integrity);
    const archive = join(directory, "rea.tgz");
    const userConfig = join(directory, "user.npmrc");
    const globalConfig = join(directory, "global.npmrc");
    await Promise.all([
      writeFile(archive, bytes, { mode: 0o600, flag: "wx" }),
      writeFile(join(directory, "package.json"), JSON.stringify({ private: true }), { mode: 0o600, flag: "wx" }),
      writeFile(userConfig, "", { mode: 0o600, flag: "wx" }),
      writeFile(globalConfig, "", { mode: 0o600, flag: "wx" }),
    ]);
    onProgress?.({ phase: "installing", message: `Installing REA ${release.version} and its dependencies privately` });
    await runReaNode(runtime.node, [runtime.npm, "install", archive,
      "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error",
      "--registry=https://registry.npmjs.org", `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
      `--cache=${join(root, "npm-cache")}`, "--engine-strict", "--fetch-retries=2", "--fetch-timeout=120000",
    ], { cwd: directory, ...(signal ? { signal } : {}), timeout: 600_000 });
    const installation: ReaInstallation = {
      version: release.version, node: runtime.node, directory,
      entry: join(directory, "node_modules", "rea-agents", "scripts", "rea.mjs"),
    };
    onProgress?.({ phase: "verifying", message: `Verifying REA ${release.version}` });
    await verifyInstallation(installation, signal);
    signal?.throwIfAborted();
    await writeFile(pointer, JSON.stringify(installation), { mode: 0o600, flag: "wx" });
    await publish(pointer, join(root, "current.json"));
    published = true;
    await rm(archive, { force: true }).catch(() => undefined);
    await pruneVersions(root, [directory, ...(before.state === "ready" ? [before.installation.directory] : [])]);
    return { ok: true, installation, changed: true };
  } finally {
    await rm(pointer, { force: true }).catch(() => undefined);
    if (!published) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function runReaMaintenance(action: ReaMaintenanceAction, options: ReaInstallOptions = {}): Promise<ReaMaintenanceResult> {
  const root = resolve(options.root ?? reaRoot());
  const existing = operations.get(root);
  if (existing) return existing.promise;
  const onProgress = (progress: ReaProgress): void => {
    const operation = operations.get(root);
    if (operation) operation.progress = progress;
    options.onProgress?.(progress);
    for (const listener of listeners) listener(root, progress);
  };
  const promise = withMcpStorageLock(`rea:${root}`, () => install(action, root, { ...options, onProgress }), options.signal)
    .catch((error: unknown): ReaMaintenanceResult => ({ ok: false, reason: failure(error) }))
    .finally(() => { operations.delete(root); });
  operations.set(root, { action, promise });
  return promise;
}
