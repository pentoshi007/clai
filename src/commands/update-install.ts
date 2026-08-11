import { spawn } from "node:child_process";
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

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes?: number | undefined;
}

export async function downloadBinary(
  url: string,
  timeoutMs = 120_000,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "clai-updater" },
    });
    if (!res.ok) {
      throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
    }
    if (!onProgress || !res.body) {
      return Buffer.from(await res.arrayBuffer());
    }
    const header = res.headers.get("content-length");
    const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
    const totalBytes = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    onProgress({ receivedBytes: 0, totalBytes });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      receivedBytes += value.byteLength;
      onProgress({ receivedBytes, totalBytes });
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
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
  readonly onProgress?: ((progress: UpdateProgress) => void) | undefined;
  /** Abort an in-flight download/install (TUI Esc / Ctrl+C). */
  readonly signal?: AbortSignal | undefined;
}

export type UpdateProgress =
  | {
      readonly phase: "downloading";
      readonly receivedBytes: number;
      readonly totalBytes?: number | undefined;
    }
  | { readonly phase: "verifying" }
  | { readonly phase: "installing"; readonly detail?: string | undefined };

function logOf(log: ((line: string) => void) | undefined): (line: string) => void {
  return log ?? ((line) => console.log(line));
}

async function replaceExecutable(
  tmp: string,
  execPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    try {
      renameSync(tmp, execPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      // Binary lives in a root-owned dir (e.g. /usr/local/bin): escalate.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("sudo", ["mv", tmp, execPath], {
          stdio: "inherit",
        });
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          finish(() =>
            reject(new Error(`could not write ${execPath} (sudo timed out)`)),
          );
        }, 120_000);
        child.on("error", () =>
          finish(() =>
            reject(
              new Error(`could not write ${execPath} (permission denied)`),
            ),
          ),
        );
        child.on("close", (status) =>
          finish(() => {
            if (status === 0) resolve();
            else
              reject(
                new Error(`could not write ${execPath} (permission denied)`),
              );
          }),
        );
      });
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
  const bin = await downloadBinary(
    url,
    120_000,
    (progress) => options.onProgress?.({ phase: "downloading", ...progress }),
    options.signal,
  );
  log(chalk.dim(`  🔐 Verifying sha256…`));
  options.onProgress?.({ phase: "verifying" });
  const expected = (await downloadBinary(sumUrl, 120_000, undefined, options.signal)).toString("utf8").trim().split(/\s+/)[0] ?? "";
  const actual = sha256(bin);
  if (!expected || expected !== actual) {
    throw new Error(`checksum mismatch for ${target.file} (expected ${expected}, got ${actual})`);
  }
  log(chalk.green(`  ✓ checksum ok (${actual})`));

  options.onProgress?.({ phase: "installing", detail: target.file });
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
    await replaceExecutable(tmp, execPath, process.platform);
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
  options.onProgress?.({ phase: "installing", detail: `${cmd} ${args[0] ?? ""}`.trim() });
  const stdio = options.stdio ?? "inherit";
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let outTail = "";
    let errTail = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(() =>
        reject(new Error(`${cmd} ${args.join(" ")} timed out after 600s`)),
      );
    }, 600_000);
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000).unref?.();
      finish(() => reject(new Error("update cancelled")));
    };
    if (options.signal?.aborted) {
      finish(() => reject(new Error("update cancelled")));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const feed = (data: unknown, isErr: boolean): void => {
      const s = String(data);
      if (isErr) stderr += s;
      else stdout += s;
      if (stdio !== "pipe") return;
      const combined = (isErr ? errTail : outTail) + s;
      const lines = combined.split(/\r?\n/);
      const tail = lines.pop() ?? "";
      if (isErr) errTail = tail;
      else outTail = tail;
      for (const line of lines) {
        if (line.trim()) log(line.replace(/\s+$/, ""));
      }
    };
    child.stdout?.on("data", (d) => feed(d, false));
    child.stderr?.on("data", (d) => feed(d, true));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => {
        if (stdio === "pipe") {
          for (const tail of [outTail, errTail]) {
            if (tail.trim()) log(tail.replace(/\s+$/, ""));
          }
        }
        resolve({ status: code, stdout, stderr });
      }),
    );
  });
  if (r.status !== 0) {
    const detail = stdio === "pipe" ? `${r.stdout}${r.stderr}`.trim() : "";
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