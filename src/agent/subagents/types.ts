import type { ChatMessage, ProviderId, ToolCall } from "../../types.js";

export type SubagentStatus = "running" | "stopping" | "completed" | "partial" | "stopped" | "error";

export interface SubagentEvent {
  readonly sequence: number;
  readonly kind: "assistant" | "tool" | "notice";
  readonly text: string;
  readonly timestamp: number;
}

export interface SubagentAssignment {
  readonly title: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  readonly cwd: string;
  readonly provider: ProviderId;
  readonly model: string;
}

export interface SubagentRun extends SubagentAssignment {
  readonly id: string;
  readonly parentSessionId: string;
  readonly attempt: number;
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly events: readonly SubagentEvent[];
  readonly report?: string | undefined;
  readonly error?: string | undefined;
  readonly recovery?: "exact" | "history" | "fresh" | undefined;
  readonly followup?: SubagentFollowup | undefined;
}

export interface SubagentFollowup {
  readonly prompt?: string | undefined;
  readonly context?: string | undefined;
}

export interface SubagentCheckpoint {
  readonly messages: readonly ChatMessage[];
  readonly nativeTools?: boolean | undefined;
  readonly reportReason?: string | undefined;
  readonly finished?: boolean | undefined;
  readonly pendingFollowup?: SubagentFollowup | undefined;
  readonly pending?: {
    readonly calls: readonly ToolCall[];
    readonly native: boolean;
    readonly next: number;
  } | undefined;
}

export interface SubagentWorkerInput {
  readonly run: SubagentRun;
  readonly signal: AbortSignal;
  readonly followup?: SubagentFollowup | undefined;
  readonly checkpoint?: SubagentCheckpoint | undefined;
  readonly saveCheckpoint?: ((checkpoint: SubagentCheckpoint) => void) | undefined;
  readonly emit: (event: {
    kind: SubagentEvent["kind"];
    text: string;
    append?: boolean;
  }) => void;
}

export type SubagentWorker = (input: SubagentWorkerInput) => Promise<string>;

export interface SubagentStore {
  load(parentSessionId: string): readonly SubagentRun[];
  save(run: SubagentRun): void;
  remove(parentSessionId: string): void;
}
