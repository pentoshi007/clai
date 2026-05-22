import { spawn } from "node:child_process";
import type { ToolResult } from "../types.js";

export interface ShellExecArgs {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function shellExec(args: ShellExecArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(args.command, {
      cwd: args.cwd ?? process.cwd(),
      detached,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
    };

    const append = (chunk: Buffer): void => {
      output += chunk.toString();
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Process may have already exited.
      }
    };

    const terminate = (reason: "abort" | "timeout"): void => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 1_000);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      cleanup();
      const trimmed = output.trim();
      if (aborted || args.signal?.aborted) {
        resolve({
          ok: false,
          output: trimmed ? `${trimmed}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
        });
        return;
      }
      if (timedOut) {
        resolve({
          ok: false,
          output: trimmed ? `${trimmed}\nCommand timed out.` : "Command timed out.",
          exitCode: 124,
        });
        return;
      }
      resolve({
        ok: code === 0,
        output: trimmed,
        exitCode: code ?? undefined,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => terminate("timeout"), args.timeoutMs ?? 180_000);
  });
}
