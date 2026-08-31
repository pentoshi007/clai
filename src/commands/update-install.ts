import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { InstallMethod, PerformUpdateOptions, UpdateInstallResult, installDirectBinary, installViaPackageManager } from "./update/installers.js";
export { DEFAULT_MIRROR_BASE, ELEVATION_TIMEOUT_MS, PACKAGE_NAME, REPO, currentPlatformTarget, downloadBinary, mirrorBaseUrl } from "./update/installers.js";
export { installDirectBinary, installViaPackageManager };
export type { DownloadProgress, InstallMethod, InstallMethodType, PerformUpdateOptions, PlatformTarget, SecretRequester, UpdateElevation, UpdateInstallResult, UpdateProgress } from "./update/installers.js";

export interface DetectEnv {
  readonly argv1: string;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  npmRoot?: string;
  bunRoot?: string;
  brewPrefix?: string;
  scoopShimsDir?: string;
}

function isWithin(target: string, root: string): boolean {
  const t = target.toLowerCase();
  const r = root.toLowerCase();
  return t === r || t.startsWith(r.endsWith("/") || r.endsWith("\\") ? r : `${r}/`) || t.startsWith(r.endsWith("/") || r.endsWith("\\") ? r : `${r}\\`);
}

function resolvedArgument(argv1: string): string {
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

export function detectInstallMethod(env: DetectEnv): InstallMethod {
  const argv1 = env.argv1 || "";
  const realArgv1 = resolvedArgument(argv1);
  const exec = env.execPath || "";
  const paths = argv1 === realArgv1 ? [argv1] : [argv1, realArgv1];
  const anyHas = (sub: string): boolean => paths.some((p) => p.includes(sub));
  const anyWithin = (root: string | undefined): boolean =>
    root !== undefined && paths.some((p) => isWithin(p, root));

  if (anyHas("src/index.ts") || anyHas("dist/index.js")) {
    return { type: "dev", detail: "running from a source checkout" };
  }

  if (env.platform === "darwin" && env.brewPrefix) {
    return { type: "brew", detail: `Homebrew formula at ${env.brewPrefix}` };
  }

  if (
    env.platform === "win32" &&
    env.scoopShimsDir &&
    anyWithin(env.scoopShimsDir)
  ) {
    return { type: "scoop", detail: `Scoop shim ${exec}` };
  }

  if (anyHas("node_modules")) {
    if (
      anyWithin(env.bunRoot) ||
      anyHas(".bun/install/global")
    ) {
      return { type: "bun", detail: `bun global install (${env.bunRoot ?? "~/.bun"})` };
    }
    if (anyWithin(env.npmRoot)) {
      return { type: "npm", detail: `npm global install (${env.npmRoot})` };
    }
    return { type: "npm", detail: "global npm/bun package" };
  }

  const base = basename(realArgv1).toLowerCase();
  const execLower = exec.toLowerCase();
  if (
    base === "clai" ||
    base === "clai.exe" ||
    base.startsWith("clai-bun-") ||
    execLower.endsWith("/clai") ||
    execLower.endsWith("\\clai") ||
    execLower.endsWith("/clai.exe") ||
    execLower.endsWith("\\clai.exe") ||
    execLower.includes("clai-bun-") ||
    (base.startsWith("clai") && (base.endsWith(".exe") || base.endsWith(".bin")))
  ) {
    return { type: "binary", detail: `standalone binary at ${exec}` };
  }

  return {
    type: "unknown",
    detail: `unrecognized install (argv=${argv1}, exec=${exec})`,
  };
}

function run(cmd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], { windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(undefined);
    }, 20000);
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      finish(code === 0 && out.trim() ? out.trim() : undefined);
    });
  });
}

function resolveBunGlobalRoot(): string | undefined {
  const prefix = process.env.BUN_INSTALL?.trim();
  const candidates: string[] = [];
  if (prefix) candidates.push(join(prefix, "install", "global", "node_modules"));
  candidates.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

export async function resolveInstallEnv(): Promise<DetectEnv> {
  const env: DetectEnv = {
    argv1: process.argv[1] ?? "",
    execPath: process.execPath,
    platform: process.platform,
    home: homedir(),
  };
  const nodeCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const [brewPrefix, npmRoot] = await Promise.all([
    process.platform === "darwin"
      ? run("brew", ["--prefix", "clai"])
      : Promise.resolve(undefined),
    run(nodeCmd, ["root", "-g"]),
  ]);
  if (brewPrefix && existsSync(join(brewPrefix, "bin", "clai"))) {
    env.brewPrefix = brewPrefix;
  }
  if (process.platform === "win32") {
    const scoop =
      process.env.SCOOP && process.env.SCOOP.trim()
        ? process.env.SCOOP.trim()
        : join(homedir(), "scoop");
    env.scoopShimsDir = join(scoop, "shims");
  }
  if (npmRoot) env.npmRoot = npmRoot;
  const bunRoot = resolveBunGlobalRoot();
  if (bunRoot) env.bunRoot = bunRoot;
  return env;
}

export async function performUpdate(
  options: PerformUpdateOptions,
): Promise<UpdateInstallResult> {
  const type = options.method.type;
  if (type === "dev" || type === "unknown") {
    return {
      ok: false,
      method: type,
      message:
        type === "dev"
          ? "running from source — pull the latest and rebuild instead"
          : "could not detect the installation method",
      needsRestart: false,
    };
  }
  if (type === "binary") {
    return installDirectBinary(options);
  }
  return installViaPackageManager(options);
}