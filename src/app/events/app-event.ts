import type { SessionPlan } from "../../store/plan.js";

// Renderer-independent event envelope for the v2 application layer (Phase 2,
// V2-020). The legacy `AgentEvent` union stays the emitter contract; the
// `AgentEventAdapter` (V2-021) wraps each one in this envelope, assigning a
// monotonic per-session `sequence` and stable domain IDs so reducers are pure
// and replayable and persistence can subscribe independently of rendering.

/** Opaque/branded string ID so distinct ID kinds cannot be mixed by accident. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type MessageId = Brand<string, "MessageId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type PlanId = Brand<string, "PlanId">;
export type TaskId = Brand<string, "TaskId">;

export const asSessionId = (value: string): SessionId => value as SessionId;
export const asTurnId = (value: string): TurnId => value as TurnId;
export const asMessageId = (value: string): MessageId => value as MessageId;
export const asToolCallId = (value: string): ToolCallId => value as ToolCallId;
export const asPlanId = (value: string): PlanId => value as PlanId;
export const asTaskId = (value: string): TaskId => value as TaskId;

/** Bumped only when the envelope shape changes in a non-additive way. */
export const APP_EVENT_VERSION = 1 as const;

export interface AppEvent<TType extends string, TPayload> {
  /** Globally unique id for this specific event occurrence. */
  readonly id: string;
  readonly version: typeof APP_EVENT_VERSION;
  /** Monotonic, gap-free counter within a session, starting at 1. */
  readonly sequence: number;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId | undefined;
  readonly timestamp: number;
  readonly type: TType;
  readonly payload: TPayload;
}

/**
 * Tool output chunks are NOT concatenated into an unbounded string in the
 * envelope. The payload carries a reference into the `OutputSpool` (keyed by
 * tool-call id); components read a bounded tail on demand. See event-buffer.ts.
 */
export interface OutputChunkRef {
  readonly toolCallId: ToolCallId;
  /** Byte length of the chunk that was just spooled (for progress display). */
  readonly chunkBytes: number;
  /** Running total bytes spooled for this tool call after this chunk. */
  readonly totalBytes: number;
}

export interface AppEventPayloads {
  "turn-started": { readonly prompt: string };
  status: { readonly text: string; readonly step?: number | undefined };
  "thinking-delta": { readonly text: string };
  "thinking-block": { readonly messageId: MessageId; readonly content: string };
  "assistant-delta": { readonly text: string };
  "assistant-message": { readonly messageId: MessageId; readonly text: string };
  notice: { readonly level: "info" | "warn"; readonly text: string };
  "tool-call": {
    readonly toolCallId: ToolCallId;
    readonly name: string;
    readonly argsDisplay: string;
  };
  "tool-output": { readonly ref: OutputChunkRef };
  "tool-result": {
    readonly toolCallId: ToolCallId;
    readonly ok: boolean;
    readonly exitCode?: number | undefined;
    readonly summary: string;
    readonly artifactPath?: string | undefined;
  };
  "tool-blocked": {
    readonly toolCallId: ToolCallId;
    readonly name: string;
    readonly reason: string;
  };
  "plan-updated": { readonly planId: PlanId; readonly plan: SessionPlan };
  "confirm-requested": {
    readonly requestId: string;
    readonly kind:
      | "tool"
      | "pentest"
      | "reset"
      | "continue"
      | "plan"
      | "switch";
    readonly prompt: string;
  };
  compacted: {
    readonly summary: string;
    readonly beforeTokens: number;
    readonly afterTokens: number;
  };
  "turn-ended": { readonly finalAnswer: string; readonly steps: number };
  "turn-aborted": Record<string, never>;
  "turn-error": { readonly message: string };
}

export type AppEventType = keyof AppEventPayloads;

export type TypedAppEvent<K extends AppEventType = AppEventType> =
  K extends AppEventType ? AppEvent<K, AppEventPayloads[K]> : never;

/** Any event in the app protocol, discriminated by `type`. */
export type AnyAppEvent = TypedAppEvent;

/**
 * Structural events end a run of coalescible deltas. The TurnController flushes
 * pending `assistant-delta`/`thinking-delta` text before emitting any of these
 * so visible order is preserved (ARCHITECTURE.md "flush before structural
 * events"). Deltas themselves are the only non-structural events.
 */
const DELTA_TYPES: ReadonlySet<AppEventType> = new Set<AppEventType>([
  "assistant-delta",
  "thinking-delta",
]);

export function isDeltaEvent(type: AppEventType): boolean {
  return DELTA_TYPES.has(type);
}

export function isStructuralEvent(type: AppEventType): boolean {
  return !DELTA_TYPES.has(type);
}
