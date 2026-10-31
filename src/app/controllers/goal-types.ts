export type GoalStatus = "active" | "paused";

export type GoalPhase = "evaluating" | "waiting" | "retrying";

export interface GoalView {
  readonly id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly phase?: GoalPhase | undefined;
  readonly startedAt: number;
  readonly turns: number;
  readonly lastReason?: string | undefined;
  readonly pauseReason?: string | undefined;
  readonly resumeOnPrompt?: boolean | undefined;
  readonly retryAt?: number | undefined;
  readonly waitingFor?: readonly string[] | undefined;
}

export type GoalReportStatus = GoalStatus | "achieved";

export interface GoalReport {
  readonly objective: string;
  readonly status: GoalReportStatus;
  readonly phase?: GoalPhase | undefined;
  readonly durationMs: number;
  readonly turns: number;
  readonly tokens: number;
  readonly lastReason?: string | undefined;
  readonly pauseReason?: string | undefined;
  readonly resumeOnPrompt?: boolean | undefined;
}

export type GoalUpdateKind =
  | "continuing"
  | "achieved"
  | "failed"
  | "paused"
  | "resumed"
  | "cleared"
  | "replaced"
  | "unrecoverable"
  | "retrying"
  | "waiting";

export interface GoalUpdate {
  readonly kind: GoalUpdateKind;
  readonly objective: string;
  readonly reason?: string | undefined;
  readonly turns?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly tokens?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly resumeOnPrompt?: boolean | undefined;
}

export type GoalSetResult =
  | { readonly ok: true; readonly objective: string; readonly replaced?: string | undefined; readonly deferred: boolean }
  | { readonly ok: false; readonly error: string };
