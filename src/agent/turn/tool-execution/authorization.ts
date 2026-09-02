import type { ToolCall } from "../../../types.js";
import type { SessionPolicy } from "../../session-policy.js";
import type { SingleToolResult } from "../contracts.js";
import { getConfig } from "../../../store/config.js";
import { isPentestToolCall } from "../../../safety/classifier.js";
import { isOutsideWorkingDirectory, resolveFsToolPath } from "../../../tools/fs.js";
import type { ConfirmPort } from "../../confirm-port.js";
import {
  confirmToolExecution,
  ensurePentestAuthorization,
  restoreInteractiveStdin,
} from "../../confirm-port.js";

const PATH_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.append",
  "fs.replaceLines",
  "fs.delete",
]);

export interface ToolAuthorizationPorts {
  readonly autoConfirm: boolean;
  readonly session: SessionPolicy;
  readonly confirmPort: ConfirmPort;
  readonly acquirePrompt: () => Promise<() => void>;
  readonly writeToolBlocked: (
    toolEventId: string,
    toolName: string,
    reason: string,
  ) => void;
  readonly emitToolResult: (
    toolEventId: string,
    result: { ok: boolean; output: string; exitCode?: number },
    contextOutput: string,
  ) => void;
}

export interface ToolAuthorizationInput {
  readonly call: ToolCall;
  readonly toolEventId: string;
  readonly parentSignal: AbortSignal;
  readonly level: "safe" | "confirm" | "block";
  readonly reason: string;
}

export type ToolAuthorizationOutcome =
  | { readonly kind: "proceed"; readonly pentestJustConfirmed: boolean }
  | { readonly kind: "stop"; readonly result: SingleToolResult };

const collectPaths = (call: ToolCall): string[] => {
  const paths: string[] = [];
  if (typeof call.args.path === "string") paths.push(call.args.path);
  if (Array.isArray(call.args.files)) {
    for (const entry of call.args.files) {
      const entryPath = (entry as { path?: string } | null)?.path;
      if (typeof entryPath === "string") paths.push(entryPath);
    }
  }
  return paths;
};

export const requiresPathConfirmation = (call: ToolCall): boolean => {
  if (call.name === "fs.delete") return true;
  if (!PATH_CONFIRM_TOOLS.has(call.name)) return false;
  for (const path of collectPaths(call)) {
    try {
      if (isOutsideWorkingDirectory(resolveFsToolPath(path))) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const blockedByClassifier = (
  input: ToolAuthorizationInput,
  ports: ToolAuthorizationPorts,
): ToolAuthorizationOutcome => {
  ports.writeToolBlocked(input.toolEventId, input.call.name, input.reason);
  const message = `Blocked: ${input.call.name} — ${input.reason}`;
  return {
    kind: "stop",
    result: {
      ok: false,
      call: input.call,
      result: { ok: false, output: message, exitCode: 1 },
      contextOutput: `${message}\nThis tool call did not run. Continue the task using a safer allowed method; do not retry the same blocked command unchanged.`,
    },
  };
};

const refused = (
  input: ToolAuthorizationInput,
  ports: ToolAuthorizationPorts,
  lastAnswer: string,
): ToolAuthorizationOutcome => {
  ports.writeToolBlocked(input.toolEventId, input.call.name, lastAnswer);
  return {
    kind: "stop",
    result: {
      ok: false,
      call: input.call,
      result: { ok: false, output: lastAnswer, exitCode: 1 },
      contextOutput: lastAnswer,
      lastAnswer,
      blockOrCancel: true,
    },
  };
};

const runPrompts = async (
  input: ToolAuthorizationInput,
  ports: ToolAuthorizationPorts,
): Promise<ToolAuthorizationOutcome> => {
  input.parentSignal.throwIfAborted();
  const needsPentestAuth =
    isPentestToolCall(input.call) &&
    !getConfig().pentestAuthorized &&
    !ports.session.pentestAuthorized.value;
  const authorized = await ensurePentestAuthorization(
    input.call,
    ports.autoConfirm,
    ports.session,
    ports.confirmPort,
  );
  restoreInteractiveStdin();
  if (!authorized) {
    return refused(input, ports, "Pentest authorization not confirmed.");
  }

  const forceConfirm = requiresPathConfirmation(input.call);
  if ((input.level !== "confirm" && !forceConfirm) || needsPentestAuth) {
    return { kind: "proceed", pentestJustConfirmed: needsPentestAuth };
  }

  const confirmed = await confirmToolExecution(
    input.call,
    forceConfirm ? false : ports.autoConfirm,
    ports.session,
    ports.confirmPort,
    forceConfirm ? { forceConfirm: true } : undefined,
  );
  restoreInteractiveStdin();
  if (!confirmed) return refused(input, ports, "Cancelled.");
  return { kind: "proceed", pentestJustConfirmed: false };
};

export const authorizeToolExecution = async (
  input: ToolAuthorizationInput,
  ports: ToolAuthorizationPorts,
): Promise<ToolAuthorizationOutcome> => {
  if (input.level === "block") return blockedByClassifier(input, ports);
  const releasePrompt = await ports.acquirePrompt();
  try {
    return await runPrompts(input, ports);
  } finally {
    releasePrompt();
  }
};
