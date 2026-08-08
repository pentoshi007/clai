import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import chalk from "chalk";

export const REPO = "pentoshi007/clai";
export const PACKAGE_NAME = "@pentoshi/clai";

export type InstallMethodType =
  | "npm"
  | "bun"
  | "brew"
  | "scoop"
  | "binary"
  | "dev"
  | "unknown";

export interface InstallMethod {
  readonly type: InstallMethodType;
  readonly detail: string;
}

export interface PlatformTarget {
  readonly platform: "darwin" | "linux" | "windows";
  readonly arch: "arm64" | "x64";
  /** Release asset name without extension, e.g. clai-bun-darwin-arm64. */
  readonly asset: string;
  /** Filename as published, with .exe appended on Windows. */
  readonly file: string;
}

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

export function currentPlatformTarget(
  platform = process.platform,
  arch = process.arch,
): PlatformTarget {
  const p = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  const a = arch === "arm64" ? "arm64" : "x64";
  const asset = `clai-bun-${p}-${a}`;
  return { platform: p, arch: a, asset, file: `${asset}${p === "windows" ? ".exe" : ""}` };
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

function run(cmd: string, args: readonly string[]): string | undefined {
  try {
    const r = spawnSync(cmd, [...args], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    // command unavailable
  }
  return undefined;
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

export function resolveInstallEnv(): DetectEnv {
  const env: DetectEnv = {
    argv1: process.argv[1] ?? "",
    execPath: process.execPath,
    platform: process.platform,
    home: homedir(),
  };
  const nodeCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (process.platform === "darwin") {
    const prefix = run("brew", ["--prefix", "clai"]);
    if (prefix && existsSync(join(prefix, "bin", "clai"))) {
      env.brewPrefix = prefix;
    }
  }
  if (process.platform === "win32") {
    const scoop =
      process.env.SCOOP && process.env.SCOOP.trim()
        ? process.env.SCOOP.trim()
        : join(homedir(), "scoop");
    env.scoopShimsDir = join(scoop, "shims");
  }
  const npmRoot = run(nodeCmd, ["root", "-g"]);
  if (npmRoot) env.npmRoot = npmRoot;
  const bunRoot = resolveBunGlobalRoot();
  if (bunRoot) env.bunRoot = bunRoot;
  return env;
}

export async function downloadBinary(
  url: string,
  timeoutMs = 120_000,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "clai-updater" },
    });
    if (!res.ok) {
      throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface UpdateInstallResult {
  readonly ok: boolean;
  readonly method: InstallMethodType;
  readonly message: string;
  /** True when the new build only takes effect after the process restarts. */
  readonly needsRestart: boolean;
}

export interface PerformUpdateOptions {
  readonly version: string;
  readonly method: InstallMethod;
  readonly target?: PlatformTarget;
  readonly repo?: string;
  readonly execPath?: string;
  readonly log?: (line: string) => void;
  /** inherit: let the child write to the terminal (CLI). pipe: capture + log (TUI). */
  readonly stdio?: "inherit" | "pipe";
}

function logOf(log: ((line: string) => void) | undefined): (line: string) => void {
  return log ?? ((line) => console.log(line));
}

function replaceExecutable(
  tmp: string,
  execPath: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    try {
      renameSync(tmp, execPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      // Binary lives in a root-owned dir (e.g. /usr/local/bin): escalate.
      const r = spawnSync("sudo", ["mv", tmp, execPath], {
        stdio: "inherit",
        timeout: 120_000,
      });
      if (r.status !== 0) {
        throw new Error(`could not write ${execPath} (permission denied)`);
      }
      return;
    }
  }
  // Windows cannot rename a running .exe: stage the new binary and defer the
  // swap to a detached helper that runs once this process exits.
  const newPath = `${execPath}.update`;
  const batPath = `${execPath}.update.cmd`;
  const exe = basename(execPath);
  renameSync(tmp, newPath);
  const script =
    `@echo off\r\n` +
    `:loop\r\n` +
    `tasklist /FI "IMAGENAME eq ${exe}" 2>nul | find /I "${exe}" >nul && (timeout /t 1 /nobreak >nul & goto loop)\r\n` +
    `move /y "${newPath}" "${execPath}"\r\n` +
    `del "%~f0"\r\n`;
  writeFileSync(batPath, script);
  const child = spawn("cmd", ["/c", "start", "", "/min", batPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function installDirectBinary(
  options: Required<Pick<PerformUpdateOptions, "version" | "method">> &
    PerformUpdateOptions,
): Promise<UpdateInstallResult> {
  const log = logOf(options.log);
  const target = options.target ?? currentPlatformTarget();
  const repo = options.repo ?? REPO;
  const execPath = options.execPath ?? process.execPath;
  const base = `https://github.com/${repo}/releases/download/v${options.version}`;
  const url = `${base}/${target.file}`;
  const sumUrl = `${base}/${target.file}.sha256`;

  log(chalk.dim(`  ⬇ Downloading ${target.file} (v${options.version})…`));
  const bin = await downloadBinary(url);
  log(chalk.dim(`  🔐 Verifying sha256…`));
  const expected = (await downloadBinary(sumUrl)).toString("utf8").trim().split(/\s+/)[0] ?? "";
  const actual = sha256(bin);
  if (!expected || expected !== actual) {
    throw new Error(`checksum mismatch for ${target.file} (expected ${expected}, got ${actual})`);
  }
  log(chalk.green(`  ✓ checksum ok (${actual})`));

  const dir = mkdtempSync(join(tmpdir(), "clai-update-"));
  try {
    const tmp = join(dir, target.file);
    writeFileSync(tmp, bin, { mode: 0o755 });
    if (process.platform !== "win32") {
      try {
        chmodSync(tmp, 0o755);
      } catch {
        // ignore
      }
    }
    replaceExecutable(tmp, execPath, process.platform);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    ok: true,
    method: "binary",
    message: `installed ${target.file} → ${execPath}`,
    needsRestart: true,
  };
}

export async function installViaPackageManager(
  options: Required<Pick<PerformUpdateOptions, "version" | "method">> &
    PerformUpdateOptions,
): Promise<UpdateInstallResult> {
  const log = logOf(options.log);
  const type = options.method.type;
  if (type !== "npm" && type !== "bun" && type !== "brew" && type !== "scoop") {
    throw new Error(`no package manager command for install method: ${type}`);
  }
  const nodeCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const bunCmd = process.platform === "win32" ? "bun.exe" : "bun";
  let cmd = "";
  let args: string[] = [];
  switch (type) {
    case "npm":
      cmd = nodeCmd;
      args = ["install", "-g", `${PACKAGE_NAME}@${options.version}`];
      break;
    case "bun":
      cmd = bunCmd;
      args = ["update", "-g", PACKAGE_NAME];
      break;
    case "brew":
      cmd = "brew";
      args = ["upgrade", `${REPO}/clai`];
      break;
    case "scoop":
      cmd = "scoop";
      args = ["update", "clai"];
      break;
  }
  log(chalk.dim(`  ⬆ Running: ${cmd} ${args.join(" ")}`));
  const stdio = options.stdio ?? "inherit";
  const r =
    stdio === "inherit"
      ? spawnSync(cmd, args, { stdio: "inherit", timeout: 600_000, windowsHide: true })
      : spawnSync(cmd, args, {
          encoding: "utf8",
          timeout: 600_000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        });
  if (stdio === "pipe") {
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) log(line.replace(/\s+$/, ""));
    }
  }
  if (r.status !== 0) {
    const detail = stdio === "pipe" ? `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() : "";
    throw new Error(
      `${cmd} ${args.join(" ")} exited with status ${r.status ?? "error"}${detail ? ` — ${detail.split("\n").slice(-6).join(" ")}` : ""}`,
    );
  }
  return {
    ok: true,
    method: type,
    message: `updated via ${type}`,
    needsRestart: true,
  };
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