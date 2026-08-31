import type { ChatMessage, ProviderId } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { PersistedContextUsage } from "../../store/history.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "./transcript-item.js";

export interface SaveSessionOptions {
  readonly sessionId?: string | undefined;
  readonly writerGeneration?: string | undefined;
  readonly revision?: number | undefined;
  readonly name?: string | undefined;
  readonly transcript?: readonly TranscriptItem[] | undefined;
  readonly contextUsage?: PersistedContextUsage | undefined;
  readonly previousTurn?: PreviousTurnSignal | null | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
}


export interface PersistencePort {
  saveSession(
    messages: readonly ChatMessage[],
    options?: SaveSessionOptions,
  ): Promise<void>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  mutatePlan?(
    sessionId: string,
    reducer: (draft: SessionPlan) => boolean | void,
  ): Promise<{ ok: boolean; plan?: SessionPlan | undefined }>;
  deletePlan(sessionId: string): Promise<void>;
}
