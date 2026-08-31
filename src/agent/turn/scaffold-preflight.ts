import type { ToolCall } from "../../types.js";
import { isScaffoldCreateCommand } from "../task-evidence.js";
import {
  resolveScaffoldTargetPath,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
} from "../workspace-orient.js";

export interface ScaffoldPreflightDecision {
  readonly skip: boolean;
  readonly message: string;
  readonly target: string | undefined;
  readonly adoptTarget: boolean;
}

const NO_SKIP: ScaffoldPreflightDecision = {
  skip: false,
  message: "",
  target: undefined,
  adoptTarget: false,
};

export const decideScaffoldPreflight = (
  call: ToolCall,
): ScaffoldPreflightDecision => {
  if (call.name !== "shell.exec" && call.name !== "shell.start") return NO_SKIP;
  const command = call.args.command;
  if (typeof command !== "string" || !isScaffoldCreateCommand(command)) {
    return NO_SKIP;
  }
  const cwdArg = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
  if (!scaffoldTargetConflictMessage(command, cwdArg)) return NO_SKIP;
  const target = resolveScaffoldTargetPath(command, cwdArg);
  const materialized = scaffoldLooksMaterialized(target);
  const location = target ? ` at ${target}` : "";
  return {
    skip: true,
    message: materialized
      ? `Scaffold skipped: the target already contains a usable project${location}. Continue that project directly; do not re-run the scaffolder.`
      : `Scaffold was not run: the existing target${location} is incomplete. Inspect and repair it before completing the scaffold task; do not retry the scaffolder into this non-empty directory.`,
    target,
    adoptTarget: Boolean(target) && materialized,
  };
};
