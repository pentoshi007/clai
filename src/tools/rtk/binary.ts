import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readlinkSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { augmentedPathEnv, findExecutable } from "../../os/command.js";
import { getDataDir } from "../../store/paths.js";

export interface RtkPathEntry {
  readonly dir: string;
  readonly position: "prepend" | "append";
}

export type RtkStatus =
  | {
      readonly state: "ready";
      readonly path: string;
      readonly version: string;
      readonly pathEntry?: RtkPathEntry | undefined;
    }
  | { readonly state: "incompatible"; readonly path: string; readonly version?: string | undefined }
  | { readonly state: "missing" };

export interface RtkGain {
  readonly commands: number;
  readonly savedTokens: number;
  readonly savingsPct: number;
}

interface RtkRun {
  readonly code: number | undefined;
  readonly stdout: string;
  readonly missing: boolean;
}

interface ProbeEntry {
  readonly at: number;
  readonly status: Promise<RtkStatus>;
  settled?: RtkStatus | undefined;
}

type Candidate =
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "incompatible"; readonly version?: string | undefined }
  | { readonly state: "missing" };

export const RTK_EXEC_ENV: Readonly<Record<string, string>> = {
  RTK_SUPPRESS_HOOK_WARNING: "1",
};

const PROBE_COMMAND = "git status";
const PROBE_TIMEOUT_MS = 3_000;
const RECHECK_MS = 30_000;
const MAX_OUTPUT_BYTES = 1 << 20;
const WINDOWS = process.platform === "win32";
const BINARY = WINDOWS ? "rtk.exe" : "rtk";

let probeEntry: ProbeEntry | undefined;

const rtkEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...RTK_EXEC_ENV,
    PATH: augmentedPathEnv(),
  };
  delete env.RTK_REWRITE_HOST;
  return env;
};

export const runRtk = (
  path: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RtkRun> =>
  new Promise((resolve) => {
    execFile(
      path,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: rtkEnv(),
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        const code = error ? error.code : 0;
        resolve({
          code: typeof code === "number" ? code : undefined,
          stdout: typeof stdout === "string" ? stdout : "",
          missing: code === "ENOENT",
        });
      },
    );
  });

const knownLocations = (): string[] => {
  const home = homedir();
  const local = process.env.LOCALAPPDATA;
  return WINDOWS
    ? [
        ...(local ? [join(local, "Microsoft", "WinGet", "Links", BINARY)] : []),
        join(home, ".cargo", "bin", BINARY),
        join(home, ".local", "bin", BINARY),
      ]
    : [
        join(home, ".local", "bin", BINARY),
        join(home, ".cargo", "bin", BINARY),
        "/opt/homebrew/bin/rtk",
        "/usr/local/bin/rtk",
        "/home/linuxbrew/.linuxbrew/bin/rtk",
      ];
};

const executable = (path: string): boolean => {
  try {
    accessSync(path, WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const probeCandidate = async (path: string): Promise<Candidate> => {
  const [version, rewrite] = await Promise.all([
    runRtk(path, ["--version"], PROBE_TIMEOUT_MS),
    runRtk(path, ["rewrite", PROBE_COMMAND], PROBE_TIMEOUT_MS),
  ]);
  if (version.missing || rewrite.missing) return { state: "missing" };
  const parsed = /^rtk\s+v?(\d+\.\d+\.\d+\S*)/.exec(version.stdout.trim())?.[1];
  const rewrites =
    (rewrite.code === 0 || rewrite.code === 3) &&
    rewrite.stdout.trim() === `rtk ${PROBE_COMMAND}`;
  return rewrites && parsed
    ? { state: "ready", version: parsed }
    : { state: "incompatible", version: parsed };
};

const shimPathEntry = (target: string): RtkPathEntry => {
  const dir = join(getDataDir(), "rtk", "bin");
  try {
    mkdirSync(dir, { recursive: true });
    if (WINDOWS) {
      const shim = join(dir, "rtk.cmd");
      const content = `@"${target}" %*\r\n`;
      const current = (() => {
        try {
          return readFileSync(shim, "utf8");
        } catch {
          return undefined;
        }
      })();
      if (current !== content) writeFileSync(shim, content);
    } else {
      const link = join(dir, "rtk");
      const current = (() => {
        try {
          return readlinkSync(link);
        } catch {
          return undefined;
        }
      })();
      if (current !== target) {
        const staging = `${link}.${process.pid}`;
        rmSync(staging, { force: true });
        symlinkSync(target, staging);
        renameSync(staging, link);
      }
    }
    return { dir, position: "prepend" };
  } catch {
    return { dir: dirname(target), position: "append" };
  }
};

export const rtkPathEnv = (entry: RtkPathEntry): string =>
  entry.position === "prepend"
    ? `${entry.dir}${delimiter}${augmentedPathEnv()}`
    : `${augmentedPathEnv()}${delimiter}${entry.dir}`;

export const probeRtkPath = async (path: string): Promise<RtkStatus> => {
  const candidate = await probeCandidate(path);
  if (candidate.state === "ready") {
    const onPath = await findExecutable("rtk");
    return path === onPath
      ? { state: "ready", path, version: candidate.version }
      : { state: "ready", path, version: candidate.version, pathEntry: shimPathEntry(path) };
  }
  if (candidate.state === "incompatible") {
    return { state: "incompatible", path, version: candidate.version };
  }
  return { state: "missing" };
};

const probe = async (): Promise<RtkStatus> => {
  try {
    const onPath = await findExecutable("rtk");
    const candidates = [...new Set([...(onPath ? [onPath] : []), ...knownLocations()])].filter(
      executable,
    );
    let incompatible: RtkStatus | undefined;
    for (const path of candidates) {
      const candidate = await probeCandidate(path);
      if (candidate.state === "ready") {
        return path === onPath
          ? { state: "ready", path, version: candidate.version }
          : { state: "ready", path, version: candidate.version, pathEntry: shimPathEntry(path) };
      }
      if (candidate.state === "incompatible") {
        incompatible ??= { state: "incompatible", path, version: candidate.version };
      }
    }
    return incompatible ?? { state: "missing" };
  } catch {
    return { state: "missing" };
  }
};

const isFresh = (entry: ProbeEntry): boolean =>
  entry.settled?.state === "ready" || Date.now() - entry.at < RECHECK_MS;

export const detectRtk = (refresh = false): Promise<RtkStatus> => {
  if (!refresh && probeEntry && isFresh(probeEntry)) return probeEntry.status;
  const entry: ProbeEntry = { at: Date.now(), status: probe() };
  void entry.status.then((status) => {
    entry.settled = status;
  });
  probeEntry = entry;
  return entry.status;
};

export const forgetRtk = (): void => {
  probeEntry = undefined;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export const readRtkGain = async (path: string): Promise<RtkGain | undefined> => {
  const run = await runRtk(path, ["gain", "--format", "json"], PROBE_TIMEOUT_MS);
  if (run.code !== 0) return undefined;
  try {
    const summary = (JSON.parse(run.stdout) as { summary?: Record<string, unknown> }).summary;
    const commands = finite(summary?.total_commands);
    const savedTokens = finite(summary?.total_saved);
    const savingsPct = finite(summary?.avg_savings_pct);
    if (commands === undefined || savedTokens === undefined || savingsPct === undefined) {
      return undefined;
    }
    return { commands, savedTokens, savingsPct };
  } catch {
    return undefined;
  }
};
