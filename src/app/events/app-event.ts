import type { ContextAttemptReference, ContextSnapshotScope } from "../../llm/context-snapshot.js";
import type { SessionPlan } from "../../store/plan.js";
import type { ProviderId } from "../../types.js";


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


export interface OutputChunkRef {
  readonly toolCallId: ToolCallId;
  /** Byte length of the chunk that was just spooled (for progress display). */
  readonly chunkBytes: number;
  /** Running total bytes spooled for this tool call after this chunk. */
  readonly totalBytes: number;
}

export interface AppEventPayloads {
  "turn-started": {
    readonly prompt: string;
    /** Transcript YOU text; null = omit user bubble (backend-only directives). */
    readonly displayPrompt?: string | null | undefined;
  };
  status: { readonly text: string; readonly step?: number | undefined };
  "thinking-delta": { readonly text: string; readonly reasoningId: string };
  "thinking-block": {
    readonly messageId: MessageId;
    readonly content: string;
    readonly reasoningId: string;
  };
  "assistant-delta": { readonly text: string };
  "assistant-message": { readonly messageId: MessageId; readonly text: string };
  notice: { readonly level: "info" | "warn"; readonly text: string };
  "tool-call": {
    readonly toolCallId: ToolCallId;
    readonly name: string;
    readonly argsDisplay: string;
  };

  "tool-started": {
    readonly toolCallId: ToolCallId;
  };
  "tool-output": { readonly ref: OutputChunkRef };
  "tool-result": {
    readonly toolCallId: ToolCallId;
    readonly ok: boolean;
    readonly exitCode?: number | undefined;
    readonly summary: string;
    readonly artifactPath?: string | undefined;
    /** Cursor-style file diffs for fs.* mutation tools. */
    readonly fileChanges?:
      | import("../../tools/file-diff.js").FileChange[]
      | undefined;
  };
  "tool-blocked": {
    readonly toolCallId: ToolCallId;
    readonly name: string;
    readonly reason: string;
  };
  "plan-updated": { readonly planId: PlanId; readonly plan: SessionPlan };
  "plan-cleared": { readonly planId: PlanId };
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
  "compaction-started": {
    readonly compactionId: string;
    readonly beforeTokens: number;
  };
  "compaction-delta": {
    readonly compactionId: string;
    readonly text: string;
    readonly replace?: boolean | undefined;
  };
  "compaction-completed": {
    readonly compactionId: string;
    readonly summary: string;
    readonly beforeTokens: number;
    readonly afterTokens: number;
    readonly contextScope: Extract<
      ContextSnapshotScope,
      "message-history" | "assembled-request"
    >;
  };
  "compaction-failed": {
    readonly compactionId: string;
    readonly message: string;
    /** Original request context retained after the failed attempt. */
    readonly retainedTokens?: number | undefined;
  };
  /** Legacy one-shot event for stored/session integrations. */
  compacted: {
    readonly summary: string;
    readonly beforeTokens: number;
    readonly afterTokens: number;
  };
  "token-usage": {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly exact: boolean;
    /** False only when the provider omitted the prompt measurement. */
    readonly promptTokensKnown?: false | undefined;
    readonly cachedPromptTokens?: number | undefined;
    readonly cacheCreationTokens?: number | undefined;
    readonly uncachedPromptTokens?: number | undefined;
    readonly reasoningTokens?: number | undefined;
    readonly model?: string | undefined;
    readonly provider?: ProviderId | undefined;
    readonly attempt?: ContextAttemptReference | undefined;
  };
  "context-estimate": {
    readonly estimatedTokens: number;
    readonly model?: string | undefined;
  };
  "turn-ended": { readonly finalAnswer: string; readonly steps: number };
  "turn-aborted": { readonly reason?: string | undefined };
  "turn-error": { readonly message: string };
}

export type AppEventType = keyof AppEventPayloads;

export type TypedAppEvent<K extends AppEventType = AppEventType> =
  K extends AppEventType ? AppEvent<K, AppEventPayloads[K]> : never;

/** Any event in the app protocol, discriminated by `type`. */
export type AnyAppEvent = TypedAppEvent;


const DELTA_TYPES: ReadonlySet<AppEventType> = new Set<AppEventType>([
  "assistant-delta",
  "thinking-delta",
  "compaction-delta",
]);

export function isDeltaEvent(type: AppEventType): boolean {
  return DELTA_TYPES.has(type);
}

export function isStructuralEvent(type: AppEventType): boolean {
  return !DELTA_TYPES.has(type);
}
