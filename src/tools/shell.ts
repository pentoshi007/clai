import { execaCommand } from "execa";
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

  try {
    const subprocess = await execaCommand(args.command, {
      cwd: args.cwd ?? process.cwd(),
      timeout: args.timeoutMs ?? 120_000,
      ...(args.signal ? { cancelSignal: args.signal } : {}),
      forceKillAfterDelay: 1_000,
      killSignal: "SIGTERM",
      reject: false,
      all: true,
      shell: true,
      stdin: "ignore",
    });
    if (args.signal?.aborted) {
      return { ok: false, output: "Command aborted.", exitCode: 130 };
    }
    return {
      ok: subprocess.exitCode === 0,
      output:
        subprocess.all ?? `${subprocess.stdout}\n${subprocess.stderr}`.trim(),
      exitCode: subprocess.exitCode,
    };
  } catch (error) {
    if (args.signal?.aborted) {
      return { ok: false, output: "Command aborted.", exitCode: 130 };
    }
    throw error;
  }
}
