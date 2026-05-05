import { execaCommand } from "execa";
import type { ToolResult } from "../types.js";

export interface ShellExecArgs {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function shellExec(args: ShellExecArgs): Promise<ToolResult> {
  const subprocess = await execaCommand(args.command, {
    cwd: args.cwd ?? process.cwd(),
    timeout: args.timeoutMs ?? 120_000,
    reject: false,
    all: true,
  });
  return {
    ok: subprocess.exitCode === 0,
    output:
      subprocess.all ?? `${subprocess.stdout}\n${subprocess.stderr}`.trim(),
    exitCode: subprocess.exitCode,
  };
}
