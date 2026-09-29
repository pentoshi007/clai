import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { augmentedPathEnv, findExecutable } from "../../os/command.js";
import { detectRtk, type RtkStatus } from "./binary.js";

export type RtkMaintenanceAction = "install" | "update";

type ReadyStatus = Extract<RtkStatus, { state: "ready" }>;

export type RtkMaintenanceResult =
  | {
      readonly ok: true;
      readonly action: RtkMaintenanceAction;
      readonly installer?: string | undefined;
      readonly status: ReadyStatus;
      readonly previousVersion?: string | undefined;
    }
  | {
      readonly ok: false;
      readonly action: RtkMaintenanceAction;
      readonly reason: string;
      readonly status: RtkStatus;
    };

export interface RtkMaintenanceState {
  readonly action: RtkMaintenanceAction;
  readonly installer?: string | undefined;
}

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

interface InstallContext {
  readonly workDir: string;
  readonly target?: string | undefined;
}

interface Installer {
  readonly id: "brew" | "script" | "cargo" | "winget";
  readonly label: string;
  readonly timeoutMs: number;
  readonly steps: (
    action: RtkMaintenanceAction,
    context: InstallContext,
  ) => Promise<readonly Step[] | undefined>;
}

export const RTK_INSTALL_HINT =
  "brew install rtk · winget install rtk-ai.rtk · cargo install --git https://github.com/rtk-ai/rtk";

const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh";
const RTK_GIT_URL = "https://github.com/rtk-ai/rtk";
const TAIL_CHARS = 4_000;
const MINUTE = 60_000;
const WINDOWS = process.platform === "win32";

const tool = async (
  name: string,
  build: (path: string) => readonly Step[],
): Promise<readonly Step[] | undefined> => {
  const path = await findExecutable(name);
  return path ? build(path) : undefined;
};

const brew: Installer = {
  id: "brew",
  label: "Homebrew",
  timeoutMs: 10 * MINUTE,
  steps: (action) =>
    tool("brew", (path) => [
      {
        command: path,
        args: [action === "install" ? "install" : "upgrade", "rtk"],
        env: { NONINTERACTIVE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
      },
    ]),
};

const script: Installer = {
  id: "script",
  label: "the official rtk installer",
  timeoutMs: 5 * MINUTE,
  steps: async (_action, context) => {
    const [curl, sh] = await Promise.all([findExecutable("curl"), findExecutable("sh")]);
    if (!curl || !sh) return undefined;
    const file = join(context.workDir, "install.sh");
    return [
      { command: curl, args: ["-fsSL", "--retry", "2", "-o", file, INSTALL_SCRIPT_URL] },
      {
        command: sh,
        args: [file],
        env: context.target ? { RTK_INSTALL_DIR: dirname(context.target) } : {},
      },
    ];
  },
};

const cargo: Installer = {
  id: "cargo",
  label: "cargo",
  timeoutMs: 30 * MINUTE,
  steps: (action) =>
    tool("cargo", (path) => [
      {
        command: path,
        args: ["install", "--git", RTK_GIT_URL, "--locked", ...(action === "install" ? ["--force"] : [])],
      },
    ]),
};

const winget: Installer = {
  id: "winget",
  label: "winget",
  timeoutMs: 10 * MINUTE,
  steps: (action) =>
    tool("winget", (path) => [
      {
        command: path,
        args: [
          action === "install" ? "install" : "upgrade",
          "--id",
          "rtk-ai.rtk",
          "--exact",
          "--silent",
          "--accept-source-agreements",
          "--accept-package-agreements",
        ],
      },
    ]),
};

const INSTALLERS: readonly Installer[] = WINDOWS ? [winget, cargo] : [brew, script, cargo];

let maintenance: { readonly state: RtkMaintenanceState; readonly done: Promise<RtkMaintenanceResult> } | undefined;
let currentInstaller: string | undefined;

export const rtkMaintenance = (): RtkMaintenanceState | undefined =>
  maintenance
    ? { ...maintenance.state, ...(currentInstaller ? { installer: currentInstaller } : {}) }
    : undefined;

const within = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const originOf = async (path: string): Promise<Installer | undefined> => {
  const real = await realpath(path).catch(() => path);
  const home = homedir();
  if (/[\\/]Cellar[\\/]rtk[\\/]/i.test(real)) return brew;
  if (/[\\/]WinGet[\\/]/i.test(real) || /[\\/]WinGet[\\/]/i.test(path)) return winget;
  if (within(real, join(home, ".cargo", "bin"))) return cargo;
  if (within(path, join(home, ".local", "bin"))) return script;
  return undefined;
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

const spawnStep = (step: Step): ChildProcess | Error => {
  try {
    return spawn(step.command, [...step.args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !WINDOWS,
      env: { ...process.env, PATH: augmentedPathEnv(), ...step.env },
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const runStep = (step: Step, timeoutMs: number): Promise<StepOutcome> =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawnStep(step);
    if (child instanceof Error) {
      resolve({ ok: false, reason: child.message, output });
      return;
    }
    const kill = (): void => {
      try {
        if (!WINDOWS && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
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
      finish(false, `timed out after ${Math.round(timeoutMs / MINUTE)} min`);
    }, timeoutMs);
    process.once("exit", kill);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code, signal) =>
      code === 0 ? finish(true) : finish(false, signal ? `stopped by ${signal}` : `exited with code ${code}`),
    );
  });

const runSteps = async (steps: readonly Step[], timeoutMs: number): Promise<StepOutcome> => {
  const deadline = Date.now() + timeoutMs;
  let last: StepOutcome = { ok: true, output: "" };
  for (const step of steps) {
    last = await runStep(step, Math.max(1_000, deadline - Date.now()));
    if (!last.ok) return last;
  }
  return last;
};

const failureReason = (label: string, outcome: StepOutcome): string => {
  const detail = lastLines(outcome.output);
  return `${label}: ${outcome.reason ?? "failed"}${detail ? ` — ${detail}` : ""}`;
};

const plan = async (
  action: RtkMaintenanceAction,
  before: RtkStatus,
): Promise<{ readonly installers: readonly Installer[]; readonly target?: string | undefined } | string> => {
  if (action === "install") return { installers: INSTALLERS };
  if (before.state !== "ready") return { installers: INSTALLERS };
  const origin = await originOf(before.path);
  return origin
    ? { installers: [origin], ...(origin === script ? { target: before.path } : {}) }
    : `rtk at ${before.path} was not installed by Homebrew, winget, cargo, or the rtk installer; update it the way you installed it`;
};

const perform = async (
  requested: RtkMaintenanceAction,
): Promise<RtkMaintenanceResult> => {
  const before = await detectRtk(true);
  const action: RtkMaintenanceAction =
    requested === "update" && before.state !== "ready" ? "install" : requested;
  if (action === "install" && before.state === "ready") {
    return { ok: true, action, status: before, previousVersion: before.version };
  }
  const planned = await plan(action, before);
  if (typeof planned === "string") return { ok: false, action, reason: planned, status: before };
  const workDir = await mkdtemp(join(tmpdir(), "clai-rtk-"));
  const failures: string[] = [];
  try {
    for (const installer of planned.installers) {
      const steps = await installer.steps(action, { workDir, target: planned.target });
      if (!steps) continue;
      currentInstaller = installer.label;
      const outcome = await runSteps(steps, installer.timeoutMs);
      const after = await detectRtk(true);
      if (after.state === "ready" && (outcome.ok || before.state !== "ready")) {
        return {
          ok: true,
          action,
          installer: installer.label,
          status: after,
          ...(before.state === "ready" ? { previousVersion: before.version } : {}),
        };
      }
      failures.push(failureReason(installer.label, outcome));
      if (action === "update") break;
    }
  } finally {
    currentInstaller = undefined;
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const status = await detectRtk(true);
  return {
    ok: false,
    action,
    reason: failures.length
      ? failures.join("; ")
      : `no supported installer found (need ${WINDOWS ? "winget or cargo" : "brew, curl, or cargo"})`,
    status,
  };
};

export const runRtkMaintenance = (
  action: RtkMaintenanceAction,
): Promise<RtkMaintenanceResult> => {
  if (maintenance) return maintenance.done;
  const done = perform(action)
    .catch(async (error: unknown): Promise<RtkMaintenanceResult> => ({
      ok: false,
      action,
      reason: error instanceof Error ? error.message : String(error),
      status: await detectRtk(true).catch((): RtkStatus => ({ state: "missing" })),
    }))
    .finally(() => {
      maintenance = undefined;
    });
  maintenance = { state: { action }, done };
  return done;
};
