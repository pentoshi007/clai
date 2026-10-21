import type { ToolCall } from "../../types.js";
import { isScaffoldCreateCommand } from "../task-evidence.js";
import {
  resolveScaffoldTargetPath,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  type WorkIntent,
} from "../workspace-orient.js";

export interface ScaffoldPreflightDecision {
  readonly skip: boolean;
  readonly message: string;
  readonly target: string | undefined;
  readonly adoptTarget: boolean;
}

export interface ScaffoldPreflightContext {
  readonly workIntent?: WorkIntent;
  readonly activeProjectRoot?: string | undefined;
}

const NO_SKIP: ScaffoldPreflightDecision = {
  skip: false,
  message: "",
  target: undefined,
  adoptTarget: false,
};

export const decideScaffoldPreflight = (
  call: ToolCall,
  context: ScaffoldPreflightContext = {},
): ScaffoldPreflightDecision => {
  if (call.name !== "shell.exec") return NO_SKIP;
  const command = call.args.command;
  if (typeof command !== "string" || !isScaffoldCreateCommand(command)) {
    return NO_SKIP;
  }
  const cwdArg = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
  if (!scaffoldTargetConflictMessage(command, cwdArg)) return NO_SKIP;
  const target = resolveScaffoldTargetPath(command, cwdArg);
  const location = target ? ` at ${target}` : "";
  if (context.workIntent === "new" && target !== context.activeProjectRoot) {
    return {
      skip: true,
      message: `Scaffold skipped: the target${location} already holds existing work that this new request does not target. Leave it untouched and scaffold into a new, non-colliding folder.`,
      target,
      adoptTarget: false,
    };
  }
  const materialized = scaffoldLooksMaterialized(target);
  return {
    skip: true,
    message: materialized
      ? `Scaffold skipped: the target already contains a usable project${location}. Continue that project directly; do not re-run the scaffolder.`
      : `Scaffold was not run: the existing target${location} is incomplete. Inspect and repair it before completing the scaffold task; do not retry the scaffolder into this non-empty directory.`,
    target,
    adoptTarget: Boolean(target) && materialized,
  };
};
