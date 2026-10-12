import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdateOrigin } from "../../os/update-origin.js";
import { PACKAGE_NAME, type InstallMethod } from "./installers.js";

export interface DetectEnv {
  readonly argv1: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly npmRoot?: string;
  readonly bunRoot?: string;
  readonly brewPrefix?: string;
  readonly scoopShimsDir?: string;
  readonly scoopRoot?: string;
  readonly packageRoot?: string;
  readonly packageManager?: "npm" | "bun" | "pnpm" | "yarn";
  readonly scope?: "global" | "local";
  readonly runtimePath?: string;
  readonly managerPath?: string;
}

export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function normalized(path: string, platform: NodeJS.Platform): string {
  const result = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? result.toLowerCase() : result;
}

function within(path: string, root: string | undefined, platform: NodeJS.Platform): boolean {
  if (!root) return false;
  const p = normalized(path, platform);
  const r = normalized(root, platform);
  return p === r || p.startsWith(`${r}/`);
}

function embedded(path: string): boolean {
  return /\$bunfs|~BUN[\\/]root|^bun:/i.test(path);
}

function packagePath(path: string): string | undefined {
  if (embedded(path)) return undefined;
  return /^(.*[\\/]node_modules[\\/]@pentoshi[\\/]clai)(?:[\\/]|$)/i.exec(path)?.[1];
}

function packageMethod(env: DetectEnv, paths: readonly string[]): InstallMethod | undefined {
  const root = paths.map(packagePath).find((path) => path !== undefined) ?? env.packageRoot;
  if (!root || !packagePath(root)) return undefined;
  const api = env.platform === "win32" ? win32 : posix;
  const nodeModules = api.dirname(api.dirname(root));
  const prefix = api.dirname(nodeModules);
  const p = normalized(root, env.platform);
  let type = env.packageManager ?? "npm";
  if (within(root, env.bunRoot, env.platform) || p.includes("/.bun/install/global/")) type = "bun";
  else if (p.includes("/.pnpm/") || /\/pnpm\/global\/\d+\//.test(p) || /\/global\/v\d+\/[^/]+\//.test(p)) type = "pnpm";
  else if (/\/yarn\/(?:data\/)?global\//.test(p)) type = "yarn";
  const knownGlobal = within(root, env.npmRoot, env.platform) || within(root, env.bunRoot, env.platform) ||
    /\/(?:lib\/node_modules|\.bun\/install\/global|yarn\/(?:data\/)?global|pnpm\/global\/\d+)(?:\/|$)/.test(p) || /\/global\/v\d+\/[^/]+\//.test(p);
  const scope = env.scope ?? (knownGlobal ? "global" : "local");
  const stablePrefix = type === "pnpm" && p.includes("/node_modules/.pnpm/")
    ? root.slice(0, p.indexOf("/node_modules/.pnpm/")) : prefix;
  const stableRoot = type === "pnpm" ? api.join(stablePrefix, "node_modules", "@pentoshi", "clai") : root;
  const installPrefix = type === "npm" && scope === "global" && /\/lib\/node_modules\//.test(p)
    ? api.dirname(stablePrefix) : stablePrefix;
  return {
    type, scope, prefix: installPrefix, packageRoot: stableRoot,
    executablePath: type === "pnpm" && scope === "global" && /\/global\/v\d+\//.test(normalized(stablePrefix, env.platform))
      ? api.join(stablePrefix.slice(0, normalized(stablePrefix, env.platform).indexOf("/global/v")), "bin", env.platform === "win32" ? "clai.cmd" : "clai")
      : api.join(stableRoot, "bin", "clai.mjs"),
    runtimePath: env.runtimePath ?? env.execPath,
    ...(env.managerPath ? { managerPath: env.managerPath } : {}),
    detail: `${type} ${scope} package at ${stableRoot}`,
  };
}

function brewOwns(env: DetectEnv, paths: readonly string[]): boolean {
  if (env.platform !== "darwin" && env.platform !== "linux") return false;
  if (!env.brewPrefix) return false;
  const roots = [env.brewPrefix, canonicalPath(env.brewPrefix)];
  const base = normalized(env.brewPrefix, env.platform).replace(/\/(?:opt|Cellar)\/clai(?:\/.*)?$/, "");
  return paths.some((path) => roots.some((root) => within(path, root, env.platform)) ||
    within(path, `${base}/Cellar/clai`, env.platform));
}

export function detectInstallMethod(env: DetectEnv): InstallMethod {
  const exec = canonicalPath(env.execPath);
  const paths = [...new Set([env.argv1, canonicalPath(env.argv1), env.execPath, exec])];
  const packaged = packageMethod(env, paths);
  if (packaged) return packaged;
  if (brewOwns(env, paths)) {
    const api = env.platform === "win32" ? win32 : posix;
    const prefix = env.brewPrefix!.replace(/\/(?:opt|Cellar)\/clai(?:\/.*)?$/, "");
    return { type: "brew", detail: `Homebrew formula at ${env.brewPrefix}`, prefix,
      executablePath: api.join(prefix, "opt", "clai", "bin", "clai"), managerPath: env.managerPath ?? api.join(prefix, "bin", "brew") };
  }
  if (env.platform === "win32" && paths.some((path) =>
    within(path, env.scoopRoot ? win32.join(env.scoopRoot, "apps", "clai") : undefined, env.platform) ||
    (within(path, env.scoopShimsDir, env.platform) && /^clai(?:\.exe)?$/i.test(win32.basename(path))))) {
    return { type: "scoop", detail: `Scoop installation at ${exec}`,
      executablePath: env.scoopRoot ? win32.join(env.scoopRoot, "apps", "clai", "current", win32.basename(exec)) : exec,
      ...(env.scope ? { scope: env.scope } : {}), ...(env.managerPath ? { managerPath: env.managerPath } : {}),
      ...(env.scoopRoot ? { prefix: env.scoopRoot } : {}) };
  }
  const api = env.platform === "win32" ? win32 : posix;
  const isRuntime = /^(?:node|nodejs|bun|bun-debug)(?:\.exe)?$/i.test(api.basename(exec));
  const bundled = paths.some(embedded);
  if (!isRuntime && (bundled || /^clai(?:-bun-.*|\.exe|\.bin)?$/i.test(api.basename(exec)))) {
    return { type: "binary", detail: `standalone binary at ${exec}`, executablePath: exec };
  }
  const source = env.packageRoot ?? paths.filter((path) => !embedded(path))
    .map((path) => /^(.*)[\\/](?:src[\\/]index\.ts|dist[\\/]index\.js|bin[\\/]clai\.mjs)$/.exec(path)?.[1])
    .find((path) => path !== undefined);
  if (isRuntime && source) return { type: "dev", detail: `source checkout at ${source}`, packageRoot: source, runtimePath: env.runtimePath ?? env.execPath };
  return { type: "unknown", detail: `unrecognized installation (entry=${env.argv1}, executable=${exec})` };
}

function ownPackageRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  if (embedded(dir)) return undefined;
  for (let i = 0; i < 8; i += 1) {
    try {
      const data: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (data && typeof data === "object" && "name" in data && data.name === PACKAGE_NAME) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function probe(cmd: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => { child.kill("SIGKILL"); finish(); };
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (data: Buffer) => { out = (out + data.toString()).slice(-8192); });
    child.on("error", () => finish());
    child.on("close", (code) => finish(code === 0 ? out.trim() || undefined : undefined));
  });
}

function projectManager(prefix: string): "npm" | "bun" | "pnpm" | "yarn" {
  if (existsSync(join(prefix, "bun.lock")) || existsSync(join(prefix, "bun.lockb"))) return "bun";
  if (existsSync(join(prefix, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(prefix, "yarn.lock"))) return "yarn";
  return "npm";
}

export async function resolveInstallEnv(signal?: AbortSignal): Promise<DetectEnv> {
  const inherited = readUpdateOrigin();
  const packageRoot = ownPackageRoot();
  const sameInstallation = inherited && (packageRoot
    ? within(canonicalPath(inherited.argv1), canonicalPath(packageRoot), process.platform)
    : canonicalPath(inherited.execPath) === canonicalPath(process.execPath));
  const origin = sameInstallation ? inherited : undefined;
  const runtimePath = origin?.execPath ?? process.execPath;
  const argv1 = origin?.argv1 ?? process.argv[1] ?? "";
  const home = homedir();
  const env: DetectEnv = { argv1, execPath: process.execPath, runtimePath, platform: process.platform, home,
    ...(packageRoot ? { packageRoot } : {}) };
  const root = packagePath(canonicalPath(argv1)) ?? packageRoot;
  if (root && packagePath(root)) {
    const marker = normalized(root, process.platform).indexOf("/node_modules/.pnpm/");
    const prefix = marker >= 0 ? root.slice(0, marker) : dirname(dirname(dirname(root)));
    const globalLayout = /[\\/]lib[\\/]node_modules[\\/]|[\\/](?:\.bun[\\/]install[\\/]global|yarn[\\/](?:data[\\/])?global|pnpm[\\/]global[\\/]\d+|global[\\/]v\d+[\\/][^\\/]+)[\\/]/i.test(root);
    const scope = globalLayout || !existsSync(join(prefix, "package.json")) ? "global" : "local";
    const packageManager = scope === "local" ? projectManager(prefix) : undefined;
    const candidate: DetectEnv = { ...env, scope, ...(packageManager ? { packageManager } : {}),
      bunRoot: join(process.env.BUN_INSTALL?.trim() || join(home, ".bun"), "install", "global", "node_modules") };
    const type = detectInstallMethod(candidate).type;
    const manager = join(dirname(runtimePath), `${type}${process.platform === "win32" ? ".cmd" : ""}`);
    const bunManager = join(dirname(dirname(prefix)), "bin", process.platform === "win32" ? "bun.exe" : "bun");
    const managerPath = type === "bun" ? bunManager : manager;
    return { ...candidate, ...(existsSync(managerPath) ? { managerPath } : {}) };
  }
  const exec = canonicalPath(process.execPath);
  if (process.platform !== "win32" && /[\\/](?:Cellar|opt)[\\/]clai[\\/]/.test(exec)) {
    const inferred = exec.includes("/Cellar/clai/")
      ? `${exec.split("/Cellar/clai/")[0]}/opt/clai` : dirname(dirname(exec));
    const managerPath = join(inferred.slice(0, inferred.lastIndexOf("/opt/clai")), "bin", "brew");
    const brewPrefix = await probe(managerPath, ["--prefix", "clai"], signal) ?? inferred;
    return { ...env, brewPrefix, managerPath };
  }
  if (process.platform === "win32") {
    const roots = [process.env.SCOOP, process.env.SCOOP_GLOBAL, join(home, "scoop"), join(process.env.ProgramData || "C:\\ProgramData", "scoop")].filter((path): path is string => Boolean(path));
    const scoopRoot = roots.find((root) => within(exec, join(root, "apps", "clai"), "win32") || within(argv1, join(root, "shims"), "win32"));
    if (scoopRoot) {
      const globalRoot = process.env.SCOOP_GLOBAL || join(process.env.ProgramData || "C:\\ProgramData", "scoop");
      const scope = normalized(scoopRoot, "win32") === normalized(globalRoot, "win32") ? "global" : "local";
      const userRoot = process.env.SCOOP || join(home, "scoop");
      return { ...env, scoopRoot, scope, scoopShimsDir: join(scoopRoot, "shims"), managerPath: join(userRoot, "apps", "scoop", "current", "bin", "scoop.ps1") };
    }
  }
  return env;
}
