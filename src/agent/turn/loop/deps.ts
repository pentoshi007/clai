import type {
  ChatMessage,
  ProviderId,
  ReasoningPreference,
  SuccessfulRequestSnapshot,
  ToolCall,
  ToolDefinition,
} from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type {
  LoopGuardStopInfo,
  TurnOutcome,
  TurnOutcomeStatus,
} from "../../turn-outcome.js";
import type { TurnState } from "../../turn-state.js";

import type { ResponderNotification } from "../../../tools/jobs.js";
import type { AgentEvent } from "../../events.js";
import type { SessionPolicy } from "../../session-policy.js";
import type { LoopGuard } from "../../loop-guard.js";
import type { OutcomeEnvelope } from "../../outcomes.js";
import type { RecoveryBudgets } from "../../must-continue.js";
import type { McpRuntime } from "../../../mcp/runtime.js";
import type { ToolDialect } from "../../../llm/tool-protocol.js";
import type { PolicyLease } from "../../../safety/engagement-policy.js";
import type { SingleToolResult, TurnOutputState } from "../contracts.js";
import type { TurnEvidenceFlags } from "../evidence-flags.js";
import type { TurnCounters } from "../turn-counters.js";
import type { ToolExecutionState } from "../tool-execution/state.js";
import type { ResponderClaimLedger } from "../responder-claims.js";

import type { WireOccurrenceLedger } from "./wire-occurrences.js";
import type { StreamRecoveryState } from "../../stream-recovery.js";
import type { TurnLoopState } from "./state.js";
import type { SalvagedWrite } from "../../tool-call-parser.js";
import type { SalvagedWriteReceipt } from "../tool-call-preparation.js";

import type { TurnWriters } from "../tool-execution/deps.js";

export interface ResponderDelivery {
  readonly id: string;
}

export interface LoopOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  readonly onSuccessfulRequest?:
    | ((snapshot: SuccessfulRequestSnapshot) => void)
    | undefined;
}

export interface TurnLoopDeps extends TurnWriters {
  readonly loop: TurnLoopState;
  readonly counters: TurnCounters;
  readonly toolState: ToolExecutionState;
  readonly evidenceFlags: TurnEvidenceFlags;
  readonly recovery: RecoveryBudgets;
  readonly session: SessionPolicy;
  readonly options: LoopOptions;
  readonly emit: (event: AgentEvent) => void;
  readonly messages: ChatMessage[];
  readonly prompt: string;
  readonly outputState: TurnOutputState;
  readonly maxIterations: number;
  readonly isPlanMode: boolean;
  readonly activePlan: SessionPlan | undefined;
  readonly buildLike: boolean;
  readonly buildLikeTurn: boolean;
  readonly pentestLike: boolean;
  readonly pentestLikeTurn: boolean;
  readonly pentestSession: boolean;
  readonly featureAppAsk: boolean;
  readonly informationalQuery: boolean;
  readonly idleOrSocialPrompt: boolean;
  readonly useCompactSystemPrompt: boolean;
  readonly thinking: ReasoningPreference | undefined;
  readonly loopGuard: LoopGuard;
  readonly mcpRuntime: McpRuntime | undefined;
  readonly mcpLease: { release: () => void } | undefined;
  readonly outcomeState: OutcomeEnvelope;
  readonly responderClaims: ResponderClaimLedger;
  readonly responderWakeTurn: boolean;
  readonly responderWakeNotificationId: string | undefined;
  readonly wireOccurrences: WireOccurrenceLedger;
  readonly recoveryState: StreamRecoveryState;
  readonly toolResultHashes: Map<string, { toolName: string; count: number }>;
  readonly alreadyPrintedIds: Set<string>;
  readonly deferredPostToolMessages: ChatMessage[];
  readonly deferredResponderLedgerNotifications: ResponderNotification[];
  readonly dialect: () => ToolDialect;
  readonly setDialect: (dialect: ToolDialect, native: boolean) => void;
  readonly nativeToolsActive: () => boolean;
  readonly composeCurrentSystemPrompt: (native: boolean) => string;
  readonly currentContextLimitTokens: () => number | undefined;
  readonly estimateNextRequestTokens: (
    messages: readonly ChatMessage[],
  ) => number;
  readonly selectToolDefs: (
    native: boolean,
    compact: boolean,
  ) => ToolDefinition[] | undefined;
  readonly maybeAutoCompact: (reason: string) => Promise<void>;
  readonly refreshResponderInbox: () => ResponderDelivery | undefined;
  readonly refreshAgentInstructions: () => Promise<void>;
  readonly refreshSessionState: (plan?: SessionPlan | undefined) => void;
  readonly recoveryUserMessage: (text: string) => ChatMessage;
  readonly applySalvagedWrite: (
    salvaged: SalvagedWrite,
  ) => Promise<SalvagedWriteReceipt>;
  readonly probeStateKey: (call: ToolCall) => string | undefined;
  readonly moveTurn: (to: TurnState, reason?: string) => void;
  readonly finishTurn: (
    answer: string,
    steps: number,
    status?: TurnOutcomeStatus,
    remainingCriteria?: readonly string[],
    reason?: string,
    displayAnswer?: string,
    loopGuardStop?: LoopGuardStopInfo,
  ) => TurnOutcome;
  readonly executeSingleTool: (
    call: ToolCall,
    toolEventId: string,
    parentSignal: AbortSignal,
  ) => Promise<SingleToolResult>;
}
