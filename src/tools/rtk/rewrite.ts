import { getConfig } from "../../store/config.js";
import { createRtkExecutionRecorder, rtkSessionEnv } from "../../store/rtk-usage.js";
export { rtkExecutionCount } from "../../store/rtk-usage.js";
import { hasStructuredReducer } from "../policies/output-policy.js";
import { looksInteractiveStdin } from "../shell.js";
import { detectRtk, forgetRtk, RTK_EXEC_ENV, rtkPathEnv, runRtk, type RtkStatus } from "./binary.js";
import { rtkMaintenance } from "./install.js";

export interface RtkExecution {
  readonly command: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly onSpawn?: (() => void) | undefined;
}

const REWRITE_TIMEOUT_MS = 2_000;
const MAX_COMMAND_CHARS = 16_000;
const REWRITE_EXIT_CODES: ReadonlySet<number> = new Set([0, 3]);
const CMD_EXE_METACHARACTERS = /[&|<>^%"()!\r\n]/;
const RTK_INVOCATION = /(?:^|[^\w./-])rtk(?:\.exe)?(?![\w./-])/i;

type ReadyRtk = Extract<RtkStatus, { state: "ready" }>;

export const rtkEnabled = (): boolean => getConfig().rtk === true;

const eligible = (command: string): boolean =>
  command.length > 0 &&
  command.length <= MAX_COMMAND_CHARS &&
  !command.includes("\0") &&
  !(process.platform === "win32" && CMD_EXE_METACHARACTERS.test(command)) &&
  !hasStructuredReducer({ toolName: "shell.exec", command }) &&
  !looksInteractiveStdin(command);

const executionEnv = (status: ReadyRtk, sessionId?: string): Readonly<Record<string, string>> => ({
  ...RTK_EXEC_ENV,
  ...rtkSessionEnv(sessionId),
  ...(status.pathEntry ? { PATH: rtkPathEnv(status.pathEntry) } : {}),
});

export async function prepareRtkExecution(
  command: string,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<RtkExecution> {
  const original = { command };
  const trimmed = command.trim();
  if (!rtkEnabled() || rtkMaintenance() || !eligible(trimmed)) return original;
  const status = await detectRtk();
  if (status.state !== "ready" || signal?.aborted) return original;
  let env: Readonly<Record<string, string>>;
  try {
    env = executionEnv(status, sessionId);
  } catch {
    return original;
  }
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
  return { command: rewritten, env, onSpawn: createRtkExecutionRecorder(sessionId) };
}
