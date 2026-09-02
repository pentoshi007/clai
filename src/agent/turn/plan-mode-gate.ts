import type { ToolCall } from "../../types.js";
import {
  isPlanModeAllowedShellCommand,
  isPlanModeAllowedTool,
} from "../session-policy.js";
import { isScratchOnlyWrite } from "../scratch-write.js";

export interface PlanModeGateInput {
  readonly call: ToolCall;
  readonly isPlanMode: boolean;
  readonly planApproved: boolean;
  readonly scratchDir: string;
  readonly mcpSafe: boolean;
}

export type PlanModeGateDecision =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly reason: string };

const commandUnderReview = (call: ToolCall): string => {
  if (call.name === "terminal.send") {
    return typeof call.args.text === "string" ? call.args.text : "";
  }
  return typeof call.args.command === "string" ? call.args.command : "";
};

const shellIsBlocked = (call: ToolCall): boolean => {
  if (call.name === "terminal.start" || call.name === "terminal.send") {
    return true;
  }
  if (call.name !== "shell.exec" && call.name !== "shell.start") return false;
  return !isPlanModeAllowedShellCommand(commandUnderReview(call));
};

export const PLAN_MODE_BLOCK_SUFFIX =
  "is blocked (gather-only). " +
  "Use any recon/enum/scan/research tool; do not write project files or run active exploits. " +
  "Put exploit/implement steps in plan.create tasks for after accept. " +
  "Accept the plan (y/i or /implement) to switch to agent and execute.";

export const decidePlanModeGate = (
  input: PlanModeGateInput,
): PlanModeGateDecision => {
  if (!input.isPlanMode || input.planApproved) return { blocked: false };
  if (isScratchOnlyWrite(input.call, input.scratchDir)) {
    return { blocked: false };
  }
  const allowed =
    (isPlanModeAllowedTool(input.call.name) || input.mcpSafe) &&
    !shellIsBlocked(input.call);
  if (allowed) return { blocked: false };
  return {
    blocked: true,
    reason: `plan mode — ${input.call.name} ${PLAN_MODE_BLOCK_SUFFIX}`,
  };
};
