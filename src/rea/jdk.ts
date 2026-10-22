import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withMcpStorageLock } from "../mcp/storage-lock.js";
import { downloadFile, fetchJsonValue, type FetchFunction } from "./download.js";
import { clearStaging, discardTree, engineRoots, removeTree, stagingName, updateEngineSettings, windowsPathProblem } from "./engines.js";
import { currentHost, type EngineHost, type EngineProgress } from "./ghidra.js";
import { publish, reaRoot } from "./install.js";
import { ensureFreeSpace, extractZip } from "./zip.js";

export const JDK_MAJOR = 21;

const ASSETS_HOST = ["api.adoptium.net"];
const DOWNLOAD_HOSTS = ["github.com", "*.githubusercontent.com"];
const RELEASE_PREFIX = `https://github.com/adoptium/temurin${JDK_MAJOR}-binaries/releases/download/`;
const MIN_ARCHIVE_BYTES = 50_000_000;
const MAX_ARCHIVE_BYTES = 800_000_000;
const MAX_EXTRACTED_BYTES = 1_500_000_000;
const MAX_ENTRIES = 20_000;
const EXTRACTED_BYTES = 450_000_000;
const JDK_DIRECTORY = /^jdk-\d/;
const DEEPEST_ENTRY_CHARS = 80;
const run = promisify(execFile);

export interface JdkRelease {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format: "tar.gz" | "zip";
}

export type JdkResolution =
  | { readonly ok: true; readonly release: JdkRelease }
  | { readonly ok: false; readonly reason: string };

export interface InstallJdkOptions {
  readonly root?: string;
  readonly release: JdkRelease;
  readonly host?: EngineHost;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: EngineProgress) => void) | undefined;
  readonly fetch?: FetchFunction | undefined;
  readonly probe?: ((home: string, platform: NodeJS.Platform) => Promise<string | undefined>) | undefined;
}

export type InstallJdkResult =
  | { readonly ok: true; readonly home: string; readonly version: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function temurinQuery(host: EngineHost, musl = false): { os: string; architecture: string } | undefined {
  const architecture = host.arch === "x64" ? "x64" : host.arch === "arm64" ? "aarch64" : undefined;
  if (!architecture) return undefined;
  if (host.platform === "darwin") return { os: "mac", architecture };
  if (host.platform === "win32") return architecture === "x64" ? { os: "windows", architecture } : undefined;
  if (host.platform === "linux") return musl ? undefined : { os: "linux", architecture };
  return undefined;
}

export function selectTemurinRelease(assets: unknown): JdkRelease {
  if (!Array.isArray(assets)) throw new Error("Unexpected JDK release listing");
  for (const asset of assets) {
    if (!isRecord(asset) || !isRecord(asset.binary) || !isRecord(asset.binary.package)) continue;
    const { link, checksum, size, name } = asset.binary.package;
    const release = typeof asset.release_name === "string" ? asset.release_name : "";
    if (typeof link !== "string" || !link.startsWith(RELEASE_PREFIX) || typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) continue;
    if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_ARCHIVE_BYTES || size > MAX_ARCHIVE_BYTES) continue;
    if (!new RegExp(`^jdk-${JDK_MAJOR}[0-9A-Za-z.+_-]*$`).test(release)) continue;
    const format = typeof name === "string" && name.endsWith(".tar.gz") ? "tar.gz" : typeof name === "string" && name.endsWith(".zip") ? "zip" : undefined;
    if (format) return { name: release, url: link, bytes: size, sha256: checksum, format };
  }
  throw new Error(`No official Temurin ${JDK_MAJOR} JDK with a published checksum was found for this system`);
}

export async function resolveJdkRelease(
  host: EngineHost = currentHost(),
  options: { signal?: AbortSignal | undefined; fetch?: FetchFunction | undefined; musl?: boolean } = {},
): Promise<JdkResolution> {
  const query = temurinQuery(host, options.musl ?? host.musl ?? false);
  if (!query) {
    return { ok: false, reason: `No official portable JDK ${JDK_MAJOR} exists for ${host.platform}/${host.arch}${host.platform === "linux" ? " (musl libc is not covered)" : ""}. Install a 64-bit JDK ${JDK_MAJOR} or newer yourself and run /rea engines use java <JDK home>.` };
  }
  const url = `https://api.adoptium.net/v3/assets/latest/${JDK_MAJOR}/hotspot?architecture=${query.architecture}&image_type=jdk&os=${query.os}&vendor=eclipse`;
  const assets = await fetchJsonValue(url, { hosts: ASSETS_HOST, maxBytes: 2 * 1024 * 1024, signal: options.signal, fetch: options.fetch });
  return { ok: true, release: selectTemurinRelease(assets) };
}

export function jdkDiskBytes(release: JdkRelease): number {
  return release.bytes + EXTRACTED_BYTES;
}

export function javaHomeIn(tree: string, platform: NodeJS.Platform): string {
  return platform === "darwin" ? join(tree, "Contents", "Home") : tree;
}

export function javaExecutable(home: string, platform: NodeJS.Platform = process.platform): string {
  return join(home, "bin", platform === "win32" ? "java.exe" : "java");
}

export async function javaVersion(home: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    const { stderr, stdout } = await run(javaExecutable(home, platform), ["-version"], { timeout: 30_000, windowsHide: true, maxBuffer: 256 * 1024 });
    return /version "([^"]+)"/.exec(`${stderr}\n${stdout}`)?.[1];
  } catch {
    return undefined;
  }
}

async function extractTarball(archive: string, destination: string, signal: AbortSignal | undefined): Promise<void> {
  const { x } = await import("tar");
  let total = 0;
  let entries = 0;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await x({
    file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, preserveOwner: false, noMtime: true,
    maxDecompressionRatio: 200,
    filter: (_path, entry) => {
      entries += 1;
      total += "size" in entry ? entry.size : 0;
      if (entries > MAX_ENTRIES || total > MAX_EXTRACTED_BYTES) throw new Error("The JDK archive exceeds extraction limits");
      return true;
    },
  });
  signal?.throwIfAborted();
}

const operations = new Map<string, Promise<InstallJdkResult>>();

async function install(options: InstallJdkOptions, root: string): Promise<InstallJdkResult> {
  const { release, signal, onProgress } = options;
  const host = options.host ?? currentHost();
  const roots = engineRoots(root);
  const target = join(roots.java, release.name);
  const home = javaHomeIn(target, host.platform);
  signal?.throwIfAborted();
  const present = await stat(javaExecutable(home, host.platform)).then((info) => info.isFile(), () => false);
  const probe = options.probe ?? javaVersion;
  const known = present ? await probe(home, host.platform) : undefined;
  if (known) {
    await updateEngineSettings((current) => ({ ...current, java: { home, managed: true, version: release.name } }), root, signal);
    return { ok: true, home, version: known, changed: false };
  }
  const tooDeep = windowsPathProblem(host.platform, roots.java, DEEPEST_ENTRY_CHARS);
  if (tooDeep) throw new Error(tooDeep);
  await mkdir(roots.java, { recursive: true, mode: 0o700 });
  await clearStaging(roots.java);
  await ensureFreeSpace(roots.java, jdkDiskBytes(release));
  const staging = join(roots.java, stagingName());
  await mkdir(staging, { mode: 0o700 });
  try {
    const archive = join(staging, `jdk.${release.format}`);
    onProgress?.({ phase: "downloading", message: `Downloading JDK ${release.name}`, totalBytes: release.bytes });
    await downloadFile(release.url, archive, {
      hosts: DOWNLOAD_HOSTS, maxBytes: MAX_ARCHIVE_BYTES, sha256: release.sha256, bytes: release.bytes, signal, fetch: options.fetch,
      onProgress: (receivedBytes, totalBytes) => onProgress?.({ phase: "downloading", message: `Downloading JDK ${release.name}`, receivedBytes, totalBytes: totalBytes ?? release.bytes }),
    });
    const tree = join(staging, "t");
    onProgress?.({ phase: "extracting", message: `Extracting JDK ${release.name}` });
    if (release.format === "zip") await extractZip(archive, tree, { strip: 1, signal, limits: { totalBytes: MAX_EXTRACTED_BYTES, entries: MAX_ENTRIES } });
    else await extractTarball(archive, tree, signal);
    await rm(archive, { force: true });
    onProgress?.({ phase: "verifying", message: `Checking the JDK runs on this machine` });
    const version = await probe(javaHomeIn(tree, host.platform), host.platform);
    if (!version) throw new Error(`The downloaded JDK does not run on ${host.platform}/${host.arch}`);
    signal?.throwIfAborted();
    if (await discardTree(target) === "busy") throw new Error(`${target} is in use by another program. Stop REA with /rea disable, then run the install again.`);
    await publish(tree, target);
    await updateEngineSettings((current) => ({ ...current, java: { home, managed: true, version: release.name } }), root, signal);
    const siblings = await readdir(roots.java, { withFileTypes: true }).catch(() => []);
    await Promise.all(siblings
      .filter((entry) => entry.isDirectory() && entry.name !== release.name && JDK_DIRECTORY.test(entry.name))
      .map((entry) => discardTree(join(roots.java, entry.name)).catch(() => undefined)));
    return { ok: true, home, version, changed: true };
  } finally {
    await removeTree(staging).catch(() => undefined);
  }
}

export function installJdk(options: InstallJdkOptions): Promise<InstallJdkResult> {
  const root = options.root ?? reaRoot();
  const key = `jdk:${engineRoots(root).java}`;
  const running = operations.get(key);
  if (running) return running;
  const promise = withMcpStorageLock(`rea-engine:${key}`, () => install(options, root), options.signal)
    .catch((error: unknown): InstallJdkResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    .finally(() => { operations.delete(key); });
  operations.set(key, promise);
  return promise;
}
