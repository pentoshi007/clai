import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import semver from "semver";
import { findExecutable } from "../os/command.js";
import { extractVerifiedZipBinary } from "../tools/rtk/archive.js";
import { extractPackage, fetchBytes, fetchJson, jsonObject, npmRelease, verifyIntegrity } from "./distribution.js";
import type { ReaInstallOptions } from "./types.js";

const execute = promisify(execFile);
const NODE_EXECUTABLE = /(?:^|[\\/])node(?:\.exe)?$/i;
const REA_NODE_RANGE = "^22.19.0 || ^24.15.0 || >=26.0.0";
const RUNTIME_GUIDANCE = "Put a compatible Node.js with npm on PATH or set CLAI_REA_NODE to its node executable.";

interface ReaNodeOptions extends ReaInstallOptions {
  readonly nodeRange?: string | undefined;
}

export interface ReaNode {
  readonly node: string;
  readonly npm: string;
}

export function supportsReaNode(version: string, nodeRange?: string): boolean {
  const installed = version.trim();
  return semver.satisfies(installed, REA_NODE_RANGE) && (nodeRange === undefined || semver.satisfies(installed, nodeRange));
}

export function reaEnvironment(node: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${dirname(node)}${delimiter}${env[pathKey] ?? ""}`;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

export async function runReaNode(
  node: string, args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number; env?: Readonly<Record<string, string>>; maxBuffer?: number } = {},
): Promise<string> {
  const { env, maxBuffer, timeout = 30_000, signal, cwd } = options;
  signal?.throwIfAborted();
  try {
    const result = await execute(node, [...args], {
      cwd, signal, timeout, env: { ...reaEnvironment(node), ...env }, windowsHide: true,
      maxBuffer: maxBuffer ?? 2 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as ExecFileException & { stderr?: string; stdout?: string };
    const output = stripVTControlCharacters(failure.stderr?.trim() || failure.stdout?.trim() || "");
    const detail = typeof failure.code === "number" ? `Node exited with code ${failure.code}`
      : failure.killed && !failure.code ? `Node timed out after ${timeout / 1000}s`
      : failure.signal ? `Node stopped with ${failure.signal}` : failure.message;
    throw new Error((output || detail).slice(0, 1_200), { cause: error });
  }
}

export function isNodeExecutable(path: string): boolean {
  return NODE_EXECUTABLE.test(path);
}

async function existingNode(nodeRange?: string, signal?: AbortSignal): Promise<ReaNode | undefined> {
  const probe = { ...(signal ? { signal } : {}), timeout: 5_000 };
  const configured = process.env.CLAI_REA_NODE;
  const candidates = [...new Set([
    configured,
    isNodeExecutable(process.execPath) ? process.execPath : undefined,
    await findExecutable("node"),
  ])];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (!candidate) continue;
    try {
      const node = await realpath(candidate);
      const version = await runReaNode(node, ["--version"], probe);
      if (!supportsReaNode(version, nodeRange)) continue;
      const bin = dirname(node);
      const paths = [
        join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
        join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      ];
      for (const npm of paths) {
        try {
          await access(npm);
          await runReaNode(node, [npm, "--version"], probe);
          return { node, npm };
        } catch { signal?.throwIfAborted(); }
      }
    } catch { signal?.throwIfAborted(); }
  }
  return undefined;
}

export function nodeTarget(platform: NodeJS.Platform, arch: string, musl = false): string {
  if (arch !== "x64" && arch !== "arm64") throw new Error(`No supported portable Node runtime for ${platform}/${arch}. ${RUNTIME_GUIDANCE}`);
  if (platform === "win32") return `win-${arch}`;
  if (platform === "darwin") return `darwin-${arch}`;
  if (platform === "linux") return `linux-${arch}${musl ? "-musl" : ""}`;
  throw new Error(`No supported portable Node runtime for ${platform}/${arch}. ${RUNTIME_GUIDANCE}`);
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
}

export async function downloadReaNode(
  directory: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly musl?: boolean },
  options: ReaNodeOptions = {},
): Promise<ReaNode> {
  const { signal, onProgress, nodeRange } = options;
  const target = nodeTarget(host.platform, host.arch, host.musl);
  const build = host.platform === "win32" ? `${target}-zip` : host.platform === "darwin" ? `osx-${host.arch}-tar` : target;
  const index = await fetchJson("https://nodejs.org/dist/index.json", signal);
  if (!Array.isArray(index)) throw new Error("Invalid official Node release index");
  const releases = index.map(jsonObject)
    .filter((item): item is { version: string; npm: string; lts?: unknown } =>
      typeof item.version === "string" && /^v\d+\.\d+\.\d+$/.test(item.version) && supportsReaNode(item.version, nodeRange) &&
      typeof item.npm === "string" && Array.isArray(item.files) && item.files.includes(build))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const release = releases.find((item) => item.lts && item.version.startsWith("v24."))
    ?? releases.find((item) => item.lts) ?? releases[0];
  if (!release) throw new Error(`No official ${target} build for Node.js ${nodeRange ?? REA_NODE_RANGE}. ${RUNTIME_GUIDANCE}`);
  const version = release.version;
  const file = host.platform === "win32" ? `node-${version}-${target}.zip` : `node-${version}-${target}.tar.gz`;
  const base = `https://nodejs.org/dist/${version}`;
  const sums = (await fetchBytes(`${base}/SHASUMS256.txt`, 512 * 1024, signal)).toString("utf8");
  const checksum = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`No checksum for official Node ${version} (${target}). ${RUNTIME_GUIDANCE}`);
  onProgress?.({ phase: "runtime", message: `Downloading private Node ${version} for ${target}` });
  const bytes = await fetchBytes(`${base}/${file}`, 128 * 1024 * 1024, signal, (receivedBytes, totalBytes) => {
    onProgress?.({ phase: "runtime", message: `Downloading private Node ${version}`, receivedBytes, ...(totalBytes ? { totalBytes } : {}) });
  });
  if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Node runtime checksum mismatch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (host.platform !== "win32") {
    await extractPackage(bytes, directory, `node-${version}-${target}`);
    const node = join(directory, "bin", "node");
    await chmod(node, 0o700);
    return { node, npm: join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js") };
  }
  const node = await extractVerifiedZipBinary(bytes, directory, "node.exe");
  const npm = await npmRelease("npm", release.npm, signal);
  const npmBytes = await fetchBytes(npm.tarball, 32 * 1024 * 1024, signal);
  verifyIntegrity(npmBytes, npm.integrity);
  const npmDirectory = join(directory, "npm");
  await extractPackage(npmBytes, npmDirectory, "package");
  return { node, npm: join(npmDirectory, "bin", "npm-cli.js") };
}

export async function resolveReaNode(directory: string, options: ReaNodeOptions = {}): Promise<ReaNode> {
  const { signal, nodeRange } = options;
  signal?.throwIfAborted();
  const existing = options.portableRuntime ? undefined : await existingNode(nodeRange, signal);
  if (existing) return existing;
  const runtime = await downloadReaNode(directory, { platform: process.platform, arch: process.arch, musl: isMusl() }, options);
  try {
    const probe = signal ? { signal } : {};
    const version = await runReaNode(runtime.node, ["--version"], probe);
    if (!supportsReaNode(version, nodeRange)) throw new Error(`Node ${version} does not meet the REA requirement (${nodeRange ?? REA_NODE_RANGE})`);
    await runReaNode(runtime.node, [runtime.npm, "--version"], probe);
  } catch (error) {
    signal?.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not use the private Node runtime. ${detail}. ${RUNTIME_GUIDANCE}`, { cause: error });
  }
  return runtime;
}
