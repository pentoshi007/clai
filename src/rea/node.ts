import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { findExecutable } from "../os/command.js";
import { extractVerifiedZipBinary } from "../tools/rtk/archive.js";
import { extractPackage, fetchBytes, fetchJson, jsonObject, npmRelease, verifyIntegrity } from "./distribution.js";
import type { ReaInstallOptions } from "./types.js";

const execute = promisify(execFile);
const NODE_EXECUTABLE = /(?:^|[\\/])node(?:\.exe)?$/i;
const RUNTIME_GUIDANCE = "Install Node.js 22.19+, 24.15+ or 26+ with npm, then put it on PATH or set CLAI_REA_NODE to its node executable.";

export interface ReaNode {
  readonly node: string;
  readonly npm: string;
}

export function supportsReaNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || (major === 24 && minor >= 15) || major >= 26;
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
  node: string, args: readonly string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<string> {
  try {
    const result = await execute(node, [...args], {
      ...options, env: reaEnvironment(node), windowsHide: true,
      timeout: options.timeout ?? 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail.slice(-6_000), { cause: error });
  }
}

export function isNodeExecutable(path: string): boolean {
  return NODE_EXECUTABLE.test(path);
}

async function existingNode(signal?: AbortSignal): Promise<ReaNode | undefined> {
  const configured = process.env.CLAI_REA_NODE;
  const candidates = [...new Set([
    configured,
    isNodeExecutable(process.execPath) ? process.execPath : undefined,
    await findExecutable("node"),
  ])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const node = await realpath(candidate);
      const version = await runReaNode(node, ["--version"], { ...(signal ? { signal } : {}), timeout: 5_000 });
      if (!supportsReaNode(version)) continue;
      const paths = [join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
        join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
      for (const npm of paths) {
        try {
          await access(npm);
          await runReaNode(node, [npm, "--version"], { ...(signal ? { signal } : {}), timeout: 5_000 });
          return { node, npm };
        } catch { continue; }
      }
    } catch { continue; }
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
  if (process.platform !== "linux" || !process.report) return false;
  const report = process.report.getReport();
  if (typeof report !== "object") return false;
  const header = jsonObject(jsonObject(report).header);
  return !header.glibcVersionRuntime;
}

export async function downloadReaNode(
  directory: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly musl?: boolean },
  options: ReaInstallOptions = {},
): Promise<ReaNode> {
  const { signal, onProgress } = options;
  const index = await fetchJson("https://nodejs.org/dist/index.json", signal);
  if (!Array.isArray(index)) throw new Error("Invalid official Node release index");
  const releases = index.map(jsonObject);
  const release = releases.find((item) => typeof item.version === "string" && /^v24\.\d+\.\d+$/.test(item.version) && item.lts);
  if (!release || typeof release.version !== "string" || !supportsReaNode(release.version)) throw new Error("No compatible Node LTS release found");
  const target = nodeTarget(host.platform, host.arch, host.musl);
  const version = release.version;
  const file = host.platform === "win32" ? `node-${version}-${target}.zip` : `node-${version}-${target}.tar.gz`;
  const base = `https://nodejs.org/dist/${version}`;
  const sums = (await fetchBytes(`${base}/SHASUMS256.txt`, 512 * 1024, signal)).toString("utf8");
  const checksum = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`Official Node LTS has no verified ${target} build. ${RUNTIME_GUIDANCE}`);
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
  if (typeof release.npm !== "string") throw new Error("Node release has no bundled npm version");
  const npm = await npmRelease("npm", release.npm, signal);
  const npmBytes = await fetchBytes(npm.tarball, 32 * 1024 * 1024, signal);
  verifyIntegrity(npmBytes, npm.integrity);
  const npmDirectory = join(directory, "npm");
  await extractPackage(npmBytes, npmDirectory, "package");
  return { node, npm: join(npmDirectory, "bin", "npm-cli.js") };
}

export async function resolveReaNode(directory: string, options: ReaInstallOptions = {}): Promise<ReaNode> {
  const existing = options.portableRuntime ? undefined : await existingNode(options.signal);
  if (existing) return existing;
  const runtime = await downloadReaNode(directory, { platform: process.platform, arch: process.arch, musl: isMusl() }, options);
  const version = await runReaNode(runtime.node, ["--version"], { ...(options.signal ? { signal: options.signal } : {}) });
  if (!supportsReaNode(version)) throw new Error(`Downloaded Node runtime is incompatible: ${version}`);
  await access(runtime.npm);
  return runtime;
}
