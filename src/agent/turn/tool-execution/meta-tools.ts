import type { ToolCall, ToolResult } from "../../../types.js";
import type { SessionPlan, TaskEvidence } from "../../../store/plan.js";
import type { ResponderNotification } from "../../../tools/jobs.js";
import type { LooseWorkReceipt, TaskWorkLedger } from "../../task-evidence.js";
import type { SingleToolResult } from "../contracts.js";
import { RUNNER_META_TOOL_NAMES } from "../../../tools/definitions.js";
import { resolvePlanTaskId } from "../../plan-tool.js";
import {
  decideResponderRead,
  parseResponderReadRequest,
  type ResponderReadWakeIdentity,
} from "../responder-read-tool.js";
import {
  decideTaskUpdateDoneGate,
  parseTaskUpdateRequest,
  type TaskUpdateGateResult,
} from "../task-update-gate.js";
import { applyTaskUpdateLedgerTransition } from "./plan-tool-ledger.js";

export interface MetaToolPlanResult {
  readonly handled: boolean;
  readonly ok: boolean;
  readonly reminder?: boolean | undefined;
  readonly toast?: string | undefined;
  readonly cleared?: boolean | undefined;
  readonly modelNote: string;
  readonly plan?: SessionPlan | undefined;
}

export interface MetaToolPorts {
  readonly step: number;
  readonly wake: ResponderReadWakeIdentity;
  readonly pendingNotifications: () => readonly ResponderNotification[];
  readonly matchesWakeRevision: (notification: ResponderNotification) => boolean;
  readonly isClaimed: (notificationId: string) => boolean;
  readonly markRead: (notificationId: string) => boolean;
  readonly releaseClaim: (notificationId: string) => void;
  readonly queueResponderLedger: (notification: ResponderNotification) => void;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly completionGate: (
    plan: SessionPlan,
    taskId: string,
  ) => TaskUpdateGateResult;
  readonly handlePlanTool: (call: ToolCall) => Promise<MetaToolPlanResult>;
  readonly recordAttempt: (call: ToolCall, ok: boolean) => void;
  readonly showCall: (call: ToolCall) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly emitToolResult: (result: ToolResult, contextOutput: string) => void;
  readonly writeToolOutput: (chunk: string) => void;
  readonly renderPlan: (plan: SessionPlan) => void;
  readonly adoptProjectRoot: (plan: SessionPlan) => void;
  readonly setPendingSessionStatePlan: (plan: SessionPlan | null) => void;
  readonly clearPlanContext: () => void;
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
  readonly looseWork: () => readonly LooseWorkReceipt[];
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<void>;
}

export type MetaToolOutcome =
  | { readonly kind: "not-meta" }
  | { readonly kind: "handled"; readonly result: SingleToolResult };

export const isRunnerMetaTool = (name: string): boolean =>
  RUNNER_META_TOOL_NAMES.has(name);

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

const rejectTaskUpdate = (
  ports: MetaToolPorts,
  call: ToolCall,
  reason: string,
): MetaToolOutcome => {
  ports.notify("warn", reason);
  ports.showCall(call);
  const result: ToolResult = { ok: false, output: reason, exitCode: 1 };
  ports.emitToolResult(result, reason);
  ports.writeToolOutput("failed\n");
  return {
    kind: "handled",
    result: { ok: false, call, result, contextOutput: reason },
  };
};

const checkTaskUpdateGate = async (
  ports: MetaToolPorts,
  call: ToolCall,
): Promise<MetaToolOutcome> => {
  const request = parseTaskUpdateRequest(call.args);
  if (request.state !== "done" || !request.taskId) return { kind: "not-meta" };
  const live = await ports.loadPlan();
  const resolved =
    (live ? resolvePlanTaskId(live, request.taskId) : undefined) ??
    request.taskId;
  const gate = decideTaskUpdateDoneGate(live, resolved, ports.completionGate);
  return gate.ok ? { kind: "not-meta" } : rejectTaskUpdate(ports, call, gate.reason);
};

const applyPlanResult = async (
  ports: MetaToolPorts,
  call: ToolCall,
  planResult: MetaToolPlanResult,
): Promise<SingleToolResult> => {
  if (!planResult.reminder) ports.recordAttempt(call, planResult.ok);
  if (planResult.ok && call.name === "task.update") {
    await applyTaskUpdateLedgerTransition(
      {
        getLedger: ports.getLedger,
        setLedger: ports.setLedger,
        looseWork: ports.looseWork,
        persistTaskEvidence: ports.persistTaskEvidence,
      },
      call,
      planResult.plan,
    );
  }
  if (planResult.ok && planResult.plan) {
    ports.setPendingSessionStatePlan(planResult.plan);
  }
  ports.showCall(call);
  if (planResult.reminder && planResult.toast) {
    ports.notify("warn", planResult.toast);
  }
  if (planResult.plan) {
    ports.renderPlan(planResult.plan);
    ports.adoptProjectRoot(planResult.plan);
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
  if (call.name === "job.read" || call.name === "task.read") {
    return handleResponderRead(ports, call);
  }
  if (call.name === "task.update") {
    const gate = await checkTaskUpdateGate(ports, call);
    if (gate.kind === "handled") return gate;
  }
  const planResult = await ports.handlePlanTool(call);
  if (!planResult.handled) return { kind: "not-meta" };
  return { kind: "handled", result: await applyPlanResult(ports, call, planResult) };
};
