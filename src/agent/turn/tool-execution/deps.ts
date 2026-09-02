import type { AgentEvent } from "../../events.js";
import type {
  ChatMessage,
  ProviderId,
  ToolCall,
  ToolResult,
} from "../../../types.js";
import type { SessionPlan, TaskEvidence } from "../../../store/plan.js";
import type { ResponderNotification } from "../../../tools/jobs.js";
import type { SessionPolicy } from "../../session-policy.js";
import type { LoopGuard } from "../../loop-guard.js";
import type { WorkLedger } from "../../durable-envelope.js";
import type { OutcomeEnvelope } from "../../outcomes.js";
import type { LooseWorkReceipt } from "../../task-evidence.js";
import type { TurnState, TurnStateSnapshot } from "../../turn-state.js";
import type { EngagementPolicyEngine } from "../../../safety/engagement-policy.js";
import type { McpRuntime } from "../../../mcp/runtime.js";
import type { ConfirmPort } from "../../confirm-port.js";
import type { PromptMutex } from "../tool-call-preparation.js";
import type { ResponderClaimLedger } from "../responder-claims.js";
import type { TaskUpdateGateResult } from "../task-update-gate.js";
import type { ToolExecutionState } from "./state.js";
import type { createTurnEventEmitter } from "../event-emitter.js";
import type { createMcpAgentToolExecutor } from "../mcp-agent-tools.js";

export type TurnWriters = ReturnType<typeof createTurnEventEmitter>;

export interface SingleToolOptions {
  readonly autoConfirm?: boolean | undefined;
  readonly requestSecret?:
    | ((request: {
        title: string;
        prompt: string;
      }) => Promise<string | undefined>)
    | undefined;
  readonly onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
  readonly onToolStart?: ((call: ToolCall) => void) | undefined;
}

export interface SingleToolDeps extends TurnWriters {
  readonly session: SessionPolicy;
  readonly emit: (event: AgentEvent) => void;
  readonly destinationHint: string | undefined;
  readonly options: SingleToolOptions;
  readonly messages: ChatMessage[];
  readonly prompt: string;
  readonly provider: () => ProviderId;
  readonly model: () => string;
  readonly step: () => number;
  readonly isPlanMode: boolean;
  readonly maxSteps: number;
  readonly pentestSession: boolean;
  readonly imageOcrEnabled: boolean;
  readonly narrowNmapOperation: boolean;
  readonly scratchDir: string;
  readonly loopGuard: LoopGuard;
  readonly mcpRuntime: McpRuntime | undefined;
  readonly workLedger: WorkLedger;
  readonly confirmPort: ConfirmPort;
  readonly promptMutex: PromptMutex;
  readonly engagementPolicy: EngagementPolicyEngine;
  readonly responderClaims: ResponderClaimLedger;
  readonly outcomeState: OutcomeEnvelope;
  readonly codingSession: () => boolean;
  readonly toolState: ToolExecutionState;
  readonly alreadyPrintedIds: Set<string>;
  readonly sessionLooseWork: LooseWorkReceipt[];
  readonly deferredPostToolMessages: ChatMessage[];
  readonly deferredResponderLedgerNotifications: ResponderNotification[];
  readonly batchRemindCalls: () => Set<ToolCall>;
  readonly batchReminderNote: () => string;
  readonly turnState: () => TurnStateSnapshot;
  readonly probeStateKey: (call: ToolCall) => string | undefined;
  readonly moveTurn: (to: TurnState, reason?: string) => void;
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<void>;
  readonly persistProjectRootOnPlan: (root: string) => Promise<void>;
  readonly completionGateForTask: (
    plan: SessionPlan,
    taskId: string,
  ) => TaskUpdateGateResult;
  readonly matchesWakeRevision: (
    notification: ResponderNotification,
  ) => boolean;
  readonly executeMcpAgentCall: ReturnType<typeof createMcpAgentToolExecutor>;
  readonly responderWakeTurn: boolean;
  readonly responderWakeNotificationId: string | undefined;
  readonly responderWakeJobId: string | undefined;
  readonly responderWakeResultRevision: number | undefined;
}
