import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { withMcpStorageLock } from "../mcp/storage-lock.js";
import { findExecutable } from "../os/command.js";
import { downloadFile, fetchJsonValue, type FetchFunction } from "./download.js";
import { engineRoots, updateEngineSettings } from "./engines.js";
import { reaRoot } from "./install.js";
import { ensureFreeSpace, extractZip } from "./zip.js";

export const GHIDRA_SERIES = "12.1";

const RELEASES_URL = "https://api.github.com/repos/NationalSecurityAgency/ghidra/releases?per_page=30";
const DOWNLOAD_HOSTS = ["github.com", "*.githubusercontent.com"];
const METADATA_HOSTS = ["api.github.com"];
const MIN_ARCHIVE_BYTES = 100_000_000;
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const BUILD_TAIL_CHARS = 6_000;
const CPP_DIRECTORY = ["Ghidra", "Features", "Decompiler", "src", "decompile", "cpp"] as const;
const EXTRACTED_BYTES = 1_000_000_000;
export const GHIDRA_INSTALLED_BYTES = 900_000_000;

export interface EngineHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface EngineProgress {
  readonly phase: "resolving" | "downloading" | "extracting" | "building" | "verifying";
  readonly message: string;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
}

export interface GhidraRelease {
  readonly version: string;
  readonly tag: string;
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type GhidraInspection =
  | { readonly ok: true; readonly dir: string; readonly version: string; readonly decompiler: boolean }
  | { readonly ok: false; readonly reason: string };

export interface InstallGhidraOptions {
  readonly root?: string;
  readonly release?: GhidraRelease;
  readonly host?: EngineHost;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: EngineProgress) => void) | undefined;
  readonly fetch?: FetchFunction | undefined;
  readonly build?: DecompilerBuilder | undefined;
}

export type InstallGhidraResult =
  | { readonly ok: true; readonly dir: string; readonly version: string; readonly built: boolean; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

export type DecompilerBuilder = (request: {
  readonly tree: string;
  readonly host: EngineHost;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: ((progress: EngineProgress) => void) | undefined;
  readonly missing?: ((host: EngineHost) => Promise<readonly string[]>) | undefined;
}) => Promise<void>;

const DECOMPILER_DIRECTORIES: Readonly<Record<string, string>> = {
  "darwin:arm64": "mac_arm_64",
  "darwin:x64": "mac_x86_64",
  "linux:x64": "linux_x86_64",
  "linux:arm64": "linux_arm_64",
  "win32:x64": "win_x86_64",
};

const BUNDLED_DECOMPILERS = new Set(["linux_x86_64", "win_x86_64"]);
const VERSION_DIRECTORY = /^\d+(?:\.\d+){1,3}$/;

export function currentHost(): EngineHost {
  return { platform: process.platform, arch: process.arch };
}

export function decompilerDirectory(host: EngineHost): string | undefined {
  return DECOMPILER_DIRECTORIES[`${host.platform}:${host.arch}`];
}

export function bundlesDecompiler(host: EngineHost): boolean {
  const directory = decompilerDirectory(host);
  return directory !== undefined && BUNDLED_DECOMPILERS.has(directory);
}

export function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function supportedGhidraVersion(version: string): boolean {
  return version === GHIDRA_SERIES || version.startsWith(`${GHIDRA_SERIES}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectGhidraRelease(releases: unknown): GhidraRelease {
  if (!Array.isArray(releases)) throw new Error("Unexpected Ghidra release listing");
  let best: GhidraRelease | undefined;
  for (const release of releases) {
    if (!isRecord(release) || release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = /^Ghidra_(\d+\.\d+(?:\.\d+)?)_build$/.exec(tag)?.[1];
    if (!version || !supportedGhidraVersion(version) || !Array.isArray(release.assets)) continue;
    const pattern = new RegExp(`^ghidra_${version.replace(/\./g, "\\.")}_PUBLIC_\\d{8}\\.zip$`);
    for (const asset of release.assets) {
      if (!isRecord(asset) || typeof asset.name !== "string" || !pattern.test(asset.name)) continue;
      const sha256 = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
      const bytes = asset.size;
      if (!sha256 || typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < MIN_ARCHIVE_BYTES || bytes > MAX_ARCHIVE_BYTES) continue;
      if (asset.state !== undefined && asset.state !== "uploaded") continue;
      if (!best || compareVersions(version, best.version) > 0) {
        best = {
          version, tag, name: asset.name, bytes, sha256,
          url: `https://github.com/NationalSecurityAgency/ghidra/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
        };
      }
    }
  }
  if (!best) throw new Error(`No official Ghidra ${GHIDRA_SERIES}.x release with a published checksum was found`);
  return best;
}

export async function resolveGhidraRelease(options: { signal?: AbortSignal | undefined; fetch?: FetchFunction | undefined } = {}): Promise<GhidraRelease> {
  const releases = await fetchJsonValue(RELEASES_URL, {
    hosts: METADATA_HOSTS, maxBytes: 8 * 1024 * 1024, signal: options.signal, fetch: options.fetch,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  return selectGhidraRelease(releases);
}

export function ghidraDiskBytes(release: GhidraRelease): number {
  return release.bytes + EXTRACTED_BYTES;
}

export async function inspectGhidraDirectory(dir: string, host: EngineHost = currentHost()): Promise<GhidraInspection> {
  let properties: string;
  try {
    properties = await readFile(join(dir, "Ghidra", "application.properties"), "utf8");
  } catch {
    return { ok: false, reason: `${dir} is not an extracted Ghidra release (Ghidra/application.properties is missing)` };
  }
  const version = /^application\.version=(\S+)\s*$/m.exec(properties)?.[1];
  if (!version) return { ok: false, reason: `${dir} does not declare a Ghidra version` };
  if (!supportedGhidraVersion(version)) return { ok: false, reason: `Ghidra ${version} is not supported by REA; it needs Ghidra ${GHIDRA_SERIES}.x` };
  const launcher = join(dir, "support", host.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless");
  if (!(await stat(launcher).then((info) => info.isFile(), () => false))) {
    return { ok: false, reason: `${dir} has no headless launcher (support/${host.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless"})` };
  }
  const directory = decompilerDirectory(host);
  const executable = host.platform === "win32" ? "decompile.exe" : "decompile";
  let decompiler = false;
  if (directory) {
    for (const base of [["os"], ["build", "os"]]) {
      const candidate = join(dir, "Ghidra", "Features", "Decompiler", ...base, directory, executable);
      if (await stat(candidate).then((info) => info.isFile(), () => false)) {
        decompiler = true;
        break;
      }
    }
  }
  return { ok: true, dir, version, decompiler };
}

export interface BuildTarget {
  readonly directory: string;
  readonly arguments: readonly string[];
}

export function decompilerBuildTarget(host: EngineHost): BuildTarget | undefined {
  const directory = decompilerDirectory(host);
  if (!directory) return undefined;
  switch (directory) {
    case "mac_arm_64": return { directory, arguments: ["ghidra_opt", "ARCH_TYPE=-arch arm64", `OSDIR=${directory}`, "ADDITIONAL_FLAGS=-w"] };
    case "mac_x86_64": return { directory, arguments: ["ghidra_opt", "ADDITIONAL_FLAGS=-w"] };
    case "linux_arm_64": return { directory, arguments: ["ghidra_opt", "ARCH_TYPE=", `OSDIR=${directory}`] };
    default: return { directory, arguments: ["ghidra_opt"] };
  }
}

export function buildToolsHelp(host: EngineHost): string {
  if (host.platform === "darwin") return "Install the Xcode Command Line Tools with `xcode-select --install`, then run the command again.";
  if (host.platform === "linux") {
    return "Install a C++ toolchain, make and bison, for example `sudo apt install build-essential bison` (Debian, Ubuntu), `sudo dnf install gcc-c++ make bison` (Fedora) or `sudo pacman -S base-devel bison` (Arch), then run the command again.";
  }
  return "Install a C++ toolchain, make and bison, then run the command again.";
}

export async function missingBuildTools(host: EngineHost): Promise<string[]> {
  const missing: string[] = [];
  if (host.platform === "darwin") {
    const ready = await new Promise<boolean>((resolve) => {
      const child = spawn("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    });
    if (!ready) return ["Xcode Command Line Tools"];
  }
  for (const [label, names] of [["make", ["make"]], ["a C++ compiler", ["g++", "c++", "clang++"]], ["bison", ["bison"]]] as const) {
    const found = await Promise.all(names.map((name) => findExecutable(name).catch(() => undefined)));
    if (!found.some(Boolean)) missing.push(label);
  }
  return missing;
}

function runMake(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("make", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-BUILD_TAIL_CHARS);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = (reason: unknown): void => {
      child.kill("SIGTERM");
      reject(reason instanceof Error ? reason : new Error("Build cancelled"));
    };
    const timer = setTimeout(() => stop(new Error("The decompiler build took longer than 30 minutes and was stopped")), BUILD_TIMEOUT_MS);
    const onAbort = (): void => stop(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`The decompiler build failed (make exited with ${code}):\n${tail.trim().split("\n").slice(-25).join("\n")}`));
    });
  });
}

export const buildGhidraDecompiler: DecompilerBuilder = async ({ tree, host, signal, onProgress, missing: probe }) => {
  const target = decompilerBuildTarget(host);
  if (!target) throw new Error(`Ghidra has no native decompiler for ${host.platform}/${host.arch}`);
  const missing = await (probe ?? missingBuildTools)(host);
  if (missing.length > 0) {
    throw new Error(`Building Ghidra's native decompiler for ${host.platform}/${host.arch} needs ${missing.join(", ")}. ${buildToolsHelp(host)}`);
  }
  onProgress?.({ phase: "building", message: `Building Ghidra's native decompiler for ${host.platform}/${host.arch} (a few minutes, once)` });
  const source = join(tree, ...CPP_DIRECTORY);
  const jobs = Math.max(1, Math.min(4, availableParallelism()));
  await runMake(source, ["-j", String(jobs), ...target.arguments], signal);
  const built = join(source, "ghidra_opt");
  const destination = join(tree, "Ghidra", "Features", "Decompiler", "os", target.directory);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const executable = join(destination, host.platform === "win32" ? "decompile.exe" : "decompile");
  await copyFile(built, executable);
  await chmod(executable, 0o755);
  const names = await readdir(source).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.endsWith(".o") || name === "ghidra_opt").map((name) => rm(join(source, name), { force: true }).catch(() => undefined)));
};

const operations = new Map<string, Promise<InstallGhidraResult>>();

async function install(release: GhidraRelease, options: InstallGhidraOptions, root: string): Promise<InstallGhidraResult> {
  const { signal, onProgress } = options;
  const host = options.host ?? currentHost();
  const roots = engineRoots(root);
  const target = join(roots.ghidra, release.version);
  signal?.throwIfAborted();
  const existing = await inspectGhidraDirectory(target, host);
  if (existing.ok && existing.decompiler) {
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir: target, managed: true, version: release.version } }), root, signal);
    return { ok: true, dir: target, version: release.version, built: false, changed: false };
  }
  await mkdir(roots.ghidra, { recursive: true, mode: 0o700 });
  await ensureFreeSpace(roots.ghidra, ghidraDiskBytes(release));
  const staging = join(roots.ghidra, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const archive = join(staging, "ghidra.zip");
    onProgress?.({ phase: "downloading", message: `Downloading Ghidra ${release.version}`, totalBytes: release.bytes });
    await downloadFile(release.url, archive, {
      hosts: DOWNLOAD_HOSTS, maxBytes: MAX_ARCHIVE_BYTES, sha256: release.sha256, bytes: release.bytes, signal, fetch: options.fetch,
      onProgress: (receivedBytes, totalBytes) => onProgress?.({ phase: "downloading", message: `Downloading Ghidra ${release.version}`, receivedBytes, totalBytes: totalBytes ?? release.bytes }),
    });
    const tree = join(staging, "tree");
    onProgress?.({ phase: "extracting", message: `Extracting Ghidra ${release.version}` });
    await extractZip(archive, tree, {
      strip: 1, signal,
      onProgress: (receivedBytes, totalBytes) => onProgress?.({ phase: "extracting", message: `Extracting Ghidra ${release.version}`, receivedBytes, totalBytes }),
    });
    await rm(archive, { force: true });
    let inspection = await inspectGhidraDirectory(tree, host);
    if (!inspection.ok) throw new Error(inspection.reason);
    let built = false;
    if (!inspection.decompiler) {
      await (options.build ?? buildGhidraDecompiler)({ tree, host, signal, onProgress });
      built = true;
      inspection = await inspectGhidraDirectory(tree, host);
      if (!inspection.ok || !inspection.decompiler) throw new Error("The native decompiler is still missing after the build");
    }
    signal?.throwIfAborted();
    await rm(target, { recursive: true, force: true });
    await rename(tree, target);
    await updateEngineSettings((current) => ({ ...current, ghidra: { dir: target, managed: true, version: release.version } }), root, signal);
    const siblings = await readdir(roots.ghidra, { withFileTypes: true }).catch(() => []);
    await Promise.all(siblings
      .filter((entry) => entry.isDirectory() && entry.name !== release.version && VERSION_DIRECTORY.test(entry.name))
      .map((entry) => rm(join(roots.ghidra, entry.name), { recursive: true, force: true }).catch(() => undefined)));
    return { ok: true, dir: target, version: release.version, built, changed: true };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function installGhidra(options: InstallGhidraOptions & { release: GhidraRelease }): Promise<InstallGhidraResult> {
  const root = options.root ?? reaRoot();
  const key = `ghidra:${engineRoots(root).ghidra}`;
  const running = operations.get(key);
  if (running) return running;
  const promise = withMcpStorageLock(`rea-engine:${key}`, () => install(options.release, options, root), options.signal)
    .catch((error: unknown): InstallGhidraResult => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }))
    .finally(() => { operations.delete(key); });
  operations.set(key, promise);
  return promise;
}
