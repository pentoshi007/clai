import { spawn, type ChildProcess } from "node:child_process";

export interface UpdateCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly log?: ((line: string) => void) | undefined;
  readonly input?: string;
  readonly platform?: NodeJS.Platform;
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("update cancelled");
}

export function psQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("invalid update command argument");
  return `'${value.replace(/'/g, "''")}'`;
}

export function windowsCommand(command: UpdateCommand): UpdateCommand {
  if (!/\.(?:cmd|bat|ps1)$/i.test(command.file)) return command;
  if (/\.(?:cmd|bat)$/i.test(command.file) && [command.file, ...command.args].some((value) => value.includes("%"))) {
    throw new Error("cannot safely pass percent-containing paths or arguments through an unidentified Windows command wrapper; use the original manager's Node/Bun entrypoint");
  }
  const invocation = `& ${psQuote(command.file)} ${command.args.map(psQuote).join(" ")}; if (-not $?) { exit 1 }; exit $LASTEXITCODE`;
  return { ...command, file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", invocation] };
}

function killTree(child: ChildProcess, platform: NodeJS.Platform, force: boolean): void {
  if (!child.pid) { child.kill(force ? "SIGKILL" : "SIGTERM"); return; }
  try {
    if (platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => child.kill("SIGKILL"));
      return;
    }
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
}

export function runUpdateCommand(command: UpdateCommand, options: RunOptions = {}): Promise<string> {
  throwIfCancelled(options.signal);
  const platform = options.platform ?? process.platform;
  const launch = platform === "win32" ? windowsCommand(command) : command;
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, [...launch.args], {
      ...(launch.cwd ? { cwd: launch.cwd } : {}),
      env: { ...process.env, ...launch.env, CI: "1" },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: platform !== "win32", windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outLine = "";
    let errLine = "";
    let failure: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(stdout.trim());
    };
    const stop = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      killTree(child, platform, false);
      killTimer = setTimeout(() => killTree(child, platform, true), 1000);
      stopTimer = setTimeout(() => finish(error), 3000);
    };
    const abort = (): void => stop(new Error("update cancelled"));
    const timer = setTimeout(() => stop(new Error(`${command.file} timed out during update`)), options.timeoutMs ?? 600_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const feed = (chunk: Buffer, error: boolean): void => {
      const text = chunk.toString();
      if (error) stderr = (stderr + text).slice(-16_384); else stdout = (stdout + text).slice(-16_384);
      const lines = ((error ? errLine : outLine) + text).split(/\r?\n/);
      const tail = (lines.pop() ?? "").slice(-2048);
      if (error) errLine = tail; else outLine = tail;
      for (const line of lines) if (line.trim()) options.log?.(line.slice(-2048).trimEnd());
    };
    child.stdout?.on("data", (data: Buffer) => feed(data, false));
    child.stderr?.on("data", (data: Buffer) => feed(data, true));
    child.on("error", (error) => finish(failure ?? new Error(`could not run ${command.file}: ${error.message}`)));
    child.on("close", (code) => {
      for (const line of [outLine, errLine]) if (line.trim()) options.log?.(line.trimEnd());
      const detail = (stderr || stdout).trim().split("\n").slice(-4).join(" ");
      finish(failure ?? (code === 0 ? undefined : new Error(`${command.file} exited with status ${code ?? "error"}${detail ? ` — ${detail}` : ""}`)));
    });
    if (options.signal?.aborted) abort();
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
  });
}
