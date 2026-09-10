import type { ProviderId } from "../../types.js";

export type SubagentStatus = "running" | "stopping" | "completed" | "stopped" | "error";

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
}

export interface SubagentWorkerInput {
  readonly run: SubagentRun;
  readonly signal: AbortSignal;
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
