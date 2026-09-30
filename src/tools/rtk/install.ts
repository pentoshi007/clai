import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { augmentedPathEnv, findExecutable } from "../../os/command.js";
import { detectRtk, forgetRtk, probeRtkPath, type RtkStatus } from "./binary.js";
import { downloadToFile } from "./download.js";
import {
  RTK_GITHUB,
  assetUrl,
  compareSemver,
  currentTarget,
  installDir,
  manualInstructions,
  pathContains,
  releaseForTag,
  resolveLatestTag,
  verifyChecksum,
  type RtkTarget,
} from "./release.js";

export type RtkMaintenanceAction = "install" | "update";
export type RtkMaintenancePhase = "preparing" | "resolving" | "downloading" | "verifying" | "extracting" | "running";
export type RtkInstallMethod = "brew" | "winget" | "binary" | "cargo";

export interface RtkProgress {
  readonly action: RtkMaintenanceAction;
  readonly phase: RtkMaintenancePhase;
  readonly method?: string | undefined;
  readonly detail?: string | undefined;
  readonly receivedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

export interface RtkMaintenanceState {
  readonly action: RtkMaintenanceAction;
  readonly phase: RtkMaintenancePhase;
  readonly installer?: string | undefined;
  readonly receivedBytes?: number | undefined;
  readonly totalBytes?: number | undefined;
}

type ReadyStatus = Extract<RtkStatus, { state: "ready" }>;

export type RtkMaintenanceResult =
  | {
      readonly ok: true;
      readonly action: RtkMaintenanceAction;
      readonly status: ReadyStatus;
      readonly installer?: string | undefined;
      readonly previousVersion?: string | undefined;
      readonly latestVersion?: string | undefined;
      readonly pathWarning?: string | undefined;
    }
  | {
      readonly ok: false;
      readonly action: RtkMaintenanceAction;
      readonly reason: string;
      readonly status: RtkStatus;
      readonly manual: string;
    };

const BREW_TIMEOUT_MS = 10 * 60_000;
const WINGET_TIMEOUT_MS = 10 * 60_000;
const CARGO_TIMEOUT_MS = 30 * 60_000;
const EXTRACT_TIMEOUT_MS = 2 * 60_000;
const TAIL_CHARS = 4_000;
const WINDOWS = process.platform === "win32";

interface Step {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
}

interface StepOutcome {
  readonly ok: boolean;
  readonly reason?: string | undefined;
  readonly output: string;
}

interface MethodOutcome {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

interface Context {
  readonly action: RtkMaintenanceAction;
  readonly target?: RtkTarget | undefined;
  readonly work: string;
  installPath?: string | undefined;
  pathWarning?: string | undefined;
}

let maintenance:
  | { readonly state: RtkMaintenanceState; readonly done: Promise<RtkMaintenanceResult> }
  | undefined;
let current: RtkMaintenanceState | undefined;
let listener: ((progress: RtkProgress) => void) | undefined;

export const setRtkMaintenanceListener = (next: ((progress: RtkProgress) => void) | undefined): void => {
  listener = next;
};

export const rtkMaintenance = (): RtkMaintenanceState | undefined => (current ? { ...current } : undefined);

const emit = (progress: RtkProgress): void => {
  current = {
    action: progress.action,
    phase: progress.phase,
    ...(progress.method ? { installer: progress.method } : {}),
    ...(progress.receivedBytes !== undefined ? { receivedBytes: progress.receivedBytes } : {}),
    ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
  };
  try {
    listener?.(progress);
  } catch {
  }
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const within = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const lastLines = (output: string): string =>
  output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" · ")
    .slice(0, 280);

const runStep = (step: Step, timeoutMs: number): Promise<StepOutcome> =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(step.command, [...step.args], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        detached: !WINDOWS,
        env: {
          ...process.env,
          PATH: augmentedPathEnv(),
          NONINTERACTIVE: "1",
          ...step.env,
        },
      });
    } catch (error) {
      resolve({ ok: false, reason: describe(error), output });
      return;
    }
    const kill = (): void => {
      try {
        if (!WINDOWS && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    };
    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("exit", kill);
      resolve({ ok, ...(reason ? { reason } : {}), output });
    };
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    const timer = setTimeout(() => {
      kill();
      finish(false, `timed out after ${Math.round(timeoutMs / 60_000)} min`);
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    process.once("exit", kill);
    child.stderr?.on("data", collect);
    child.stdout?.on("data", collect);
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code, signal) =>
      code === 0 ? finish(true) : finish(false, signal ? `stopped by ${signal}` : `exited with code ${code}`),
    );
  });

const stepFailure = (outcome: StepOutcome): string =>
  `${outcome.reason ?? "failed"}${lastLines(outcome.output) ? ` — ${lastLines(outcome.output)}` : ""}`;

const runQuiet = (command: string, args: readonly string[], work: string): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        cwd: work,
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish(false);
    }, EXTRACT_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });

const extractTar = async (context: Context, file: string, name: string): Promise<boolean> =>
  (await runQuiet("tar", ["-xzf", file, name], context.work)) ||
  (await runQuiet("tar", ["-xzf", file, "-C", context.work, name], context.work));

const extractZip = async (context: Context, file: string, name: string): Promise<boolean> => {
  const script = `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${context.work.replace(/'/g, "''")}' -Force`;
  if (!(await runQuiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], context.work))) {
    return false;
  }
  return access(join(context.work, name), constants.F_OK).then(
    () => true,
    () => false,
  );
};

const originOf = async (path: string): Promise<RtkInstallMethod | undefined> => {
  const real = await realpath(path).catch(() => path);
  const home = homedir();
  if (/[\\/]Cellar[\\/]rtk[\\/]/i.test(real)) return "brew";
  if (/[\\/]WinGet[\\/]/i.test(real)) return "winget";
  if (within(real, join(home, ".cargo", "bin"))) return "cargo";
  if (within(real, join(home, ".local", "bin"))) return "binary";
  return undefined;
};

const runBrew = async (context: Context): Promise<MethodOutcome> => {
  const brew = await findExecutable("brew");
  if (!brew) return { ok: false, reason: "Homebrew is not installed" };
  emit({ action: context.action, phase: "running", method: "Homebrew" });
  const env = { NONINTERACTIVE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_AUTO_UPDATE: "1" };
  const verb = context.action === "update" ? "upgrade" : "install";
  const result = await runStep({ command: brew, args: [verb, "rtk"], env }, BREW_TIMEOUT_MS);
  if (!result.ok) return { ok: false, reason: stepFailure(result) };
  if (context.target?.os === "linux") {
    await runStep({ command: brew, args: ["link", "--overwrite", "--force", "rtk"], env }, BREW_TIMEOUT_MS);
  }
  return { ok: true };
};

const runWinget = async (context: Context): Promise<MethodOutcome> => {
  const winget = await findExecutable("winget");
  if (!winget) return { ok: false, reason: "winget is not installed" };
  emit({ action: context.action, phase: "running", method: "winget" });
  const verb = context.action === "update" ? "upgrade" : "install";
  const result = await runStep(
    {
      command: winget,
      args: [verb, "--id", "rtk-ai.rtk", "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements"],
    },
    WINGET_TIMEOUT_MS,
  );
  return result.ok ? { ok: true } : { ok: false, reason: stepFailure(result) };
};

const runCargo = async (context: Context): Promise<MethodOutcome> => {
  const cargo = await findExecutable("cargo");
  if (!cargo) return { ok: false, reason: "cargo is not installed" };
  emit({ action: context.action, phase: "running", method: "cargo" });
  const result = await runStep(
    { command: cargo, args: ["install", "--git", RTK_GITHUB, "--locked", "--force"] },
    CARGO_TIMEOUT_MS,
  );
  return result.ok ? { ok: true } : { ok: false, reason: stepFailure(result) };
};

const placeBinary = async (context: Context, staged: string, dir: string, name: string): Promise<void> => {
  const dest = join(dir, name);
  const temp = `${dest}.${process.pid}.tmp`;
  await copyFile(staged, temp);
  if (context.target?.os !== "windows") await chmod(temp, 0o755);
  try {
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  context.installPath = dest;
  if (!pathContains(dir)) {
    context.pathWarning = `${dir} is not on your PATH — add \`export PATH="${dir}:$PATH"\` to your shell profile`;
  }
};

const runBinary = async (context: Context): Promise<MethodOutcome> => {
  const target = context.target;
  if (!target) return { ok: false, reason: "no pre-built rtk binary is published for this platform" };
  emit({ action: context.action, phase: "resolving", method: "GitHub releases" });
  let tag: string;
  let release: Awaited<ReturnType<typeof releaseForTag>>;
  try {
    tag = await resolveLatestTag();
    release = await releaseForTag(tag);
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  const file = join(context.work, target.asset);
  emit({ action: context.action, phase: "downloading", method: "GitHub releases", receivedBytes: 0 });
  try {
    await downloadToFile(assetUrl(tag, target.asset), file, {
      onProgress: (progress) =>
        emit({
          action: context.action,
          phase: "downloading",
          method: "GitHub releases",
          receivedBytes: progress.receivedBytes,
          ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
        }),
    });
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  emit({ action: context.action, phase: "verifying", method: "GitHub releases" });
  const archive = await readFile(file).catch(() => undefined);
  if (!archive) return { ok: false, reason: "downloaded archive could not be read back" };
  const verdict = verifyChecksum(archive, target.asset, release.checksums);
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "checksum verification failed" };
  const dir = installDir();
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch {
    return { ok: false, reason: `${dir} is not writable — set RTK_INSTALL_DIR to a writable directory` };
  }
  const name = target.os === "windows" ? "rtk.exe" : "rtk";
  emit({ action: context.action, phase: "extracting", method: "GitHub releases" });
  const extracted =
    target.asset.endsWith(".zip") ? await extractZip(context, file, name) : await extractTar(context, file, name);
  if (!extracted) return { ok: false, reason: "could not extract the rtk archive (need `tar`, or PowerShell on Windows)" };
  try {
    await placeBinary(context, join(context.work, name), dir, name);
  } catch (error) {
    return { ok: false, reason: `could not install to ${dir}: ${describe(error)}` };
  }
  return { ok: true };
};

const METHOD_LABEL: Record<RtkInstallMethod, string> = {
  brew: "Homebrew",
  winget: "winget",
  cargo: "cargo",
  binary: "GitHub releases",
};

const runMethod = (method: RtkInstallMethod, context: Context): Promise<MethodOutcome> => {
  switch (method) {
    case "brew":
      return runBrew(context);
    case "winget":
      return runWinget(context);
    case "cargo":
      return runCargo(context);
    case "binary":
      return runBinary(context);
  }
};

export const planInstall = (
  windows: boolean,
  target: RtkTarget | undefined,
): readonly RtkInstallMethod[] =>
  windows
    ? target
      ? ["winget", "binary", "cargo"]
      : ["winget", "cargo"]
    : target
      ? ["brew", "binary", "cargo"]
      : ["brew", "cargo"];

export const planUpdate = (
  windows: boolean,
  origin: RtkInstallMethod | undefined,
  target: RtkTarget | undefined,
): readonly RtkInstallMethod[] => {
  const fallbacks: readonly RtkInstallMethod[] = target ? ["binary", "cargo"] : ["cargo"];
  if (origin === "brew") return ["brew", ...fallbacks];
  if (origin === "winget") return windows ? ["winget", ...fallbacks] : fallbacks;
  if (origin === "cargo") return ["cargo"];
  return fallbacks;
};

const verifyInstalled = async (context: Context): Promise<RtkStatus> =>
  context.installPath ? probeRtkPath(context.installPath) : detectRtk(true);

const latestVersion = async (): Promise<string> => (await resolveLatestTag()).replace(/^v/, "");

const perform = async (requested: RtkMaintenanceAction): Promise<RtkMaintenanceResult> => {
  emit({ action: requested, phase: "preparing" });
  const before = await detectRtk(true);
  const action: RtkMaintenanceAction = requested === "update" && before.state !== "ready" ? "install" : requested;
  const target = currentTarget();
  if (action === "install" && before.state === "ready") {
    return { ok: true, action, status: before, previousVersion: before.version };
  }
  if (action === "update" && before.state === "ready") {
    try {
      const latest = await latestVersion();
      const cmp = compareSemver(before.version, latest);
      if (cmp !== undefined && cmp >= 0) {
        return {
          ok: true,
          action,
          status: before,
          previousVersion: before.version,
          latestVersion: latest,
        };
      }
    } catch (error) {
      return {
        ok: false,
        action,
        reason: `could not check the latest rtk release — ${describe(error)}`,
        status: before,
        manual: manualInstructions(target),
      };
    }
  }
  const shouldSuggestBrew = !WINDOWS && (await findExecutable("brew")) === undefined;
  const methods =
    action === "update" && before.state === "ready"
      ? planUpdate(WINDOWS, await originOf(before.path), target)
      : planInstall(WINDOWS, target);
  const work = await mkdtemp(join(tmpdir(), "clai-rtk-"));
  const failures: string[] = [];
  try {
    for (const method of methods) {
      const context: Context = { action, target, work };
      const outcome = await runMethod(method, context);
      if (!outcome.ok) {
        failures.push(`${METHOD_LABEL[method]}: ${outcome.reason ?? "failed"}`);
        continue;
      }
      const after = await verifyInstalled(context);
      if (after.state === "ready") {
        return {
          ok: true,
          action,
          status: after,
          installer: METHOD_LABEL[method],
          ...(before.state === "ready" ? { previousVersion: before.version } : {}),
          ...(context.pathWarning ? { pathWarning: context.pathWarning } : {}),
        };
      }
      failures.push(`${METHOD_LABEL[method]}: ran but rtk still is not usable (\`rtk rewrite\` did not respond)`);
      if (action === "update") break;
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  const status = await detectRtk(true);
  const missing: string[] = [];
  if ((await findExecutable("brew")) === undefined) missing.push("Homebrew");
  if ((await findExecutable("curl")) === undefined && (await findExecutable("wget")) === undefined) missing.push("curl");
  if (!target) missing.push(`a published rtk build for ${WINDOWS ? "this Windows arch" : "this platform"}`);
  return {
    ok: false,
    action,
    reason:
      failures.length > 0
        ? failures.join("; ")
        : `no supported install method available${missing.length ? ` (${missing.join("; ")})` : ""}`,
    status,
    manual: shouldSuggestBrew
      ? `${manualInstructions(target)}\n  • Homebrew for Linux: https://docs.brew.sh/Homebrew-on-Linux`
      : manualInstructions(target),
  };
};

export const runRtkMaintenance = (action: RtkMaintenanceAction): Promise<RtkMaintenanceResult> => {
  if (maintenance) return maintenance.done;
  const done = perform(action)
    .catch(
      async (error: unknown): Promise<RtkMaintenanceResult> => ({
        ok: false,
        action,
        reason: describe(error),
        status: await detectRtk(true).catch((): RtkStatus => ({ state: "missing" })),
        manual: manualInstructions(currentTarget()),
      }),
    )
    .finally(() => {
      forgetRtk();
      maintenance = undefined;
      current = undefined;
    });
  maintenance = { state: { action, phase: "preparing" }, done };
  return done;
};
