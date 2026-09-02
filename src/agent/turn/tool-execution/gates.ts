import type { ToolCall, ToolResult } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { SingleToolResult } from "../contracts.js";
import {
  isPreApprovalAllowedTool,
} from "../../session-policy.js";
import { isScratchOnlyWrite } from "../../scratch-write.js";
import { decidePlanModeGate } from "../plan-mode-gate.js";

export interface ToolGateStagePorts {
  readonly isPlanMode: boolean;
  readonly planApproved: () => boolean;
  readonly scratchDir: string;
  readonly mcpSafe: (call: ToolCall) => boolean;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly showCall: (call: ToolCall) => void;
  readonly emitToolResult: (result: ToolResult, contextOutput: string) => void;
  readonly writeToolOutput: (chunk: string) => void;
}

export type ToolGateDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "stop"; readonly result: SingleToolResult };

export const runToolGates = async (
  ports: ToolGateStagePorts,
  call: ToolCall,
  level: "safe" | "confirm" | "block",
  livePlan: SessionPlan | undefined,
): Promise<ToolGateDecision> => {
  const planModeGate = decidePlanModeGate({
    call,
    isPlanMode: ports.isPlanMode,
    planApproved: ports.planApproved(),
    scratchDir: ports.scratchDir,
    mcpSafe: ports.mcpSafe(call),
  });
  if (planModeGate.blocked) {
    const reason = planModeGate.reason;
    ports.notify("warn", reason);
    ports.showCall(call);
    const result: ToolResult = { ok: false, output: reason, exitCode: 1 };
    ports.emitToolResult(result, reason);
    ports.writeToolOutput("failed\n");
    return {
      kind: "stop",
      result: { ok: false, call, result, contextOutput: reason },
    };
  }

  const isMutatingAction =
    (level === "confirm" || level === "block") &&
    !isPreApprovalAllowedTool(call.name) &&
    !isScratchOnlyWrite(call, ports.scratchDir);
  if (!isMutatingAction) return { kind: "proceed" };

  const planNow = livePlan ?? (await ports.loadPlan());
  if (!planNow || ports.planApproved()) return { kind: "proceed" };
  const reason = `plan awaiting approval — ${call.name} is blocked until the plan is accepted (/implement or Accept)`;
  ports.notify("warn", reason);
  return {
    kind: "stop",
    result: {
      ok: false,
      call,
      result: { ok: false, output: reason, exitCode: 1 },
      contextOutput: reason,
      blockOrCancel: true,
    },
  };
};
