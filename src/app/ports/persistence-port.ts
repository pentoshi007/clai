import type { ChatMessage, ProviderId, ReasoningPreference } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { HistorySessionLocation, PersistedContextUsage } from "../../store/history.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "./transcript-item.js";
import type { FileLineChanges } from "../controllers/session-changes.js";

export interface SaveSessionOptions {
  readonly sessionId?: string | undefined;
  readonly writerGeneration?: string | undefined;
  readonly revision?: number | undefined;
  readonly name?: string | undefined;
  readonly transcript?: readonly TranscriptItem[] | undefined;
  readonly changes?: readonly FileLineChanges[] | undefined;
  readonly contextUsage?: PersistedContextUsage | undefined;
  readonly previousTurn?: PreviousTurnSignal | null | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly thinking?: ReasoningPreference | undefined;
  readonly location?: HistorySessionLocation | undefined;
  readonly unsyncedItemIds?: readonly string[] | undefined;
}

export interface PersistedQueuedPrompt {
  readonly id: number;
  readonly text: string;
  readonly displayPrompt?: string | null | undefined;
}

export interface PersistedSessionMerge {
  readonly transcript: readonly TranscriptItem[];
}


export interface PersistencePort {
  loadQueuedPrompts?(sessionId: string): readonly PersistedQueuedPrompt[];
  saveQueuedPrompts?(sessionId: string, prompts: readonly PersistedQueuedPrompt[]): void;
  saveSession(
    messages: readonly ChatMessage[],
    options?: SaveSessionOptions,
  ): Promise<PersistedSessionMerge | void>;
  pendingSessionMerge?(sessionId: string): Promise<PersistedSessionMerge | undefined>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  mutatePlan?(
    sessionId: string,
    reducer: (draft: SessionPlan) => boolean | void,
  ): Promise<{ ok: boolean; plan?: SessionPlan | undefined }>;
  deletePlan(sessionId: string): Promise<void>;
}
