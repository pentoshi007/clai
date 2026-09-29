import { execFile } from "node:child_process";
import { augmentedPathEnv, findExecutable } from "../../os/command.js";

export type RtkStatus =
  | { readonly state: "ready"; readonly path: string; readonly version: string }
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

export const RTK_EXEC_ENV: Readonly<Record<string, string>> = {
  RTK_SUPPRESS_HOOK_WARNING: "1",
};

const PROBE_COMMAND = "git status";
const PROBE_TIMEOUT_MS = 3_000;
const RECHECK_MS = 30_000;
const MAX_OUTPUT_BYTES = 1 << 20;

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

const probe = async (): Promise<RtkStatus> => {
  try {
    const path = await findExecutable("rtk");
    if (!path) return { state: "missing" };
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
      ? { state: "ready", path, version: parsed }
      : { state: "incompatible", path, version: parsed };
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
