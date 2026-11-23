import type { ToolCall, ToolResult } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { ResponderNotification } from "../../../tools/jobs.js";
import type { TaskUpdateWork } from "../../plan/actions/task-update.js";
import type { PlanToolResult } from "../../plan-tool.js";
import type { SingleToolResult } from "../contracts.js";
import { RUNNER_META_TOOL_NAMES } from "../../../tools/definitions.js";
import {
  isTurnEndReason,
  TURN_END_REASONS,
  TURN_END_TOOL_NAME,
} from "../../../tools/turn-end.js";
import {
  decideResponderRead,
  parseResponderReadRequest,
  type ResponderReadWakeIdentity,
} from "../responder-read-tool.js";

export interface MetaToolPorts {
  readonly wake: ResponderReadWakeIdentity;
  readonly pendingNotifications: () => readonly ResponderNotification[];
  readonly matchesWakeRevision: (notification: ResponderNotification) => boolean;
  readonly isClaimed: (notificationId: string) => boolean;
  readonly markRead: (notificationId: string) => boolean;
  readonly releaseClaim: (notificationId: string) => void;
  readonly queueResponderLedger: (notification: ResponderNotification) => void;
  readonly handlePlanTool: (call: ToolCall) => Promise<PlanToolResult>;
  readonly recordAttempt: (call: ToolCall, ok: boolean) => void;
  readonly showCall: (call: ToolCall) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly emitToolResult: (result: ToolResult, contextOutput: string) => void;
  readonly writeToolOutput: (chunk: string) => void;
  readonly renderPlan: (plan: SessionPlan) => void;
  readonly adoptProjectRoot: (plan: SessionPlan) => void;
  readonly setPendingSessionStatePlan: (plan: SessionPlan | null) => void;
  readonly clearPlanContext: () => void;
  readonly setTaskWork: (work: TaskUpdateWork) => void;
}

export type MetaToolOutcome =
  | { readonly kind: "not-meta" }
  | { readonly kind: "handled"; readonly result: SingleToolResult };

export const isRunnerMetaTool = (name: string): boolean =>
  RUNNER_META_TOOL_NAMES.has(name);

const handleTurnEnd = (
  ports: MetaToolPorts,
  call: ToolCall,
): MetaToolOutcome => {
  const reason = call.args.reason;
  const ok = isTurnEndReason(reason);
  const output = ok
    ? `Turn end declared: ${reason}. It applies only when every other call in this response succeeded as plan or job bookkeeping; otherwise review the results and declare again when finished.`
    : `turn.end needs reason set to one of: ${TURN_END_REASONS.join(", ")}.`;
  ports.showCall(call);
  const result: ToolResult = ok ? { ok, output } : { ok, output, exitCode: 1 };
  ports.emitToolResult(result, output);
  ports.writeToolOutput(ok ? "ok\n" : "failed\n");
  return {
    kind: "handled",
    result: { ok, call, result, contextOutput: output },
  };
};

const handleResponderRead = (
  ports: MetaToolPorts,
  call: ToolCall,
): MetaToolOutcome => {
  const decision = decideResponderRead(
    parseResponderReadRequest(call.name, call.args),
    ports.wake,
    {
      pendingNotifications: ports.pendingNotifications(),
      matchesWakeRevision: ports.matchesWakeRevision,
      isClaimed: ports.isClaimed,
      markRead: ports.markRead,
    },
  );
  if (decision.ledgerNotification) {
    ports.queueResponderLedger(decision.ledgerNotification);
  }
  if (decision.releaseClaimId) ports.releaseClaim(decision.releaseClaimId);
  ports.showCall(call);
  const result: ToolResult = {
    ok: decision.marked,
    output: decision.output,
    ...(decision.marked ? {} : { exitCode: 1 }),
  };
  ports.recordAttempt(call, decision.marked);
  ports.emitToolResult(result, decision.output);
  ports.writeToolOutput(decision.marked ? "read\n" : "failed\n");
  return {
    kind: "handled",
    result: {
      ok: decision.marked,
      call,
      result,
      contextOutput: decision.output,
    },
  };
};

const applyPlanResult = (
  ports: MetaToolPorts,
  call: ToolCall,
  planResult: PlanToolResult,
): SingleToolResult => {
  if (!planResult.reminder) ports.recordAttempt(call, planResult.ok);
  const livePlan = planResult.plan;
  if (planResult.ok && planResult.taskWork) ports.setTaskWork(planResult.taskWork);
  if (planResult.ok && livePlan) {
    ports.setPendingSessionStatePlan(livePlan);
  }
  ports.showCall(call);
  if (planResult.reminder && planResult.toast) {
    ports.notify("warn", planResult.toast);
  }
  if (livePlan) {
    ports.renderPlan(livePlan);
    ports.adoptProjectRoot(livePlan);
  }
  if (planResult.ok && planResult.cleared) {
    ports.setPendingSessionStatePlan(null);
    ports.clearPlanContext();
  }
  const result: ToolResult = {
    ok: planResult.ok,
    output: planResult.modelNote,
  };
  ports.emitToolResult(result, planResult.modelNote);
  ports.writeToolOutput(result.ok ? "ok\n" : "failed\n");
  return {
    ok: planResult.ok,
    call,
    result,
    contextOutput: planResult.modelNote,
  };
};

export const runMetaTool = async (
  ports: MetaToolPorts,
  call: ToolCall,
): Promise<MetaToolOutcome> => {
  if (!isRunnerMetaTool(call.name)) return { kind: "not-meta" };
  if (call.name === TURN_END_TOOL_NAME) {
    return handleTurnEnd(ports, call);
  }
  if (call.name === "job.read") {
    return handleResponderRead(ports, call);
  }
  const planResult = await ports.handlePlanTool(call);
  if (!planResult.handled) return { kind: "not-meta" };
  return { kind: "handled", result: applyPlanResult(ports, call, planResult) };
};
