import { getConfig } from "../../store/config.js";
import { hasStructuredReducer } from "../policies/output-policy.js";
import { looksInteractiveStdin } from "../shell.js";
import { detectRtk, forgetRtk, RTK_EXEC_ENV, rtkPathEnv, runRtk, type RtkStatus } from "./binary.js";
import { rtkMaintenance } from "./install.js";

export interface RtkExecution {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

const REWRITE_TIMEOUT_MS = 2_000;
const MAX_COMMAND_CHARS = 16_000;
const REWRITE_EXIT_CODES: ReadonlySet<number> = new Set([0, 3]);
const CMD_EXE_METACHARACTERS = /[&|<>^%"()!\r\n]/;
const RTK_INVOCATION = /(?:^|[^\w./-])rtk(?:\.exe)?(?![\w./-])/i;

type ReadyRtk = Extract<RtkStatus, { state: "ready" }>;

let rewriteCount = 0;

export const rtkRewriteCount = (): number => rewriteCount;

export const rtkEnabled = (): boolean => getConfig().rtk === true;

const eligible = (command: string): boolean =>
  command.length > 0 &&
  command.length <= MAX_COMMAND_CHARS &&
  !command.includes("\0") &&
  !(process.platform === "win32" && CMD_EXE_METACHARACTERS.test(command)) &&
  !hasStructuredReducer({ toolName: "shell.exec", command }) &&
  !looksInteractiveStdin(command);

const executionEnv = (status: ReadyRtk): Readonly<Record<string, string>> =>
  status.pathEntry ? { ...RTK_EXEC_ENV, PATH: rtkPathEnv(status.pathEntry) } : RTK_EXEC_ENV;

export async function prepareRtkExecution(
  command: string,
  signal?: AbortSignal,
): Promise<RtkExecution> {
  const original = { command };
  const trimmed = command.trim();
  if (!rtkEnabled() || rtkMaintenance() || !eligible(trimmed)) return original;
  const status = await detectRtk();
  if (status.state !== "ready" || signal?.aborted) return original;
  const env = executionEnv(status);
  const unchanged: RtkExecution = RTK_INVOCATION.test(trimmed) ? { command, env } : original;
  const run = await runRtk(status.path, ["rewrite", trimmed], REWRITE_TIMEOUT_MS, signal);
  if (run.missing) {
    forgetRtk();
    return original;
  }
  const rewritten = run.stdout.trim();
  if (
    run.code === undefined ||
    !REWRITE_EXIT_CODES.has(run.code) ||
    !rewritten ||
    rewritten === trimmed ||
    rewritten.includes("\n")
  ) {
    return unchanged;
  }
  rewriteCount += 1;
  return { command: rewritten, env };
}
