import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { PersistedContextUsage } from "../../store/history.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "./transcript-item.js";

export interface SaveSessionOptions {
  /** When set, upsert this session id (continuous autosave) instead of minting a new row. */
  readonly sessionId?: string | undefined;
  /** Unique writer generation; compared before the per-writer revision. */
  readonly writerGeneration?: string | undefined;
  /**
   * Monotonic snapshot revision within one writer generation. Storage rejects
   * lower revisions so a slow autosave cannot overwrite a newer save.
   */
  readonly revision?: number | undefined;
  /** Optional display name. */
  readonly name?: string | undefined;
  /** Classic-shaped visual transcript for full /history restore. */
  readonly transcript?: readonly TranscriptItem[] | undefined;
  /** Token/context footer snapshot so /history resume matches the live count. */
  readonly contextUsage?: PersistedContextUsage | undefined;
  /** Restart checkpoint. Null clears a previously persisted unfinished turn. */
  readonly previousTurn?: PreviousTurnSignal | null | undefined;
}


export interface PersistencePort {
  saveSession(
    messages: readonly ChatMessage[],
    options?: SaveSessionOptions,
  ): Promise<void>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  /**
   * Transactional plan mutation. Optional so lightweight test
   * doubles can keep implementing only `savePlan`.
   */
  mutatePlan?(
    sessionId: string,
    reducer: (draft: SessionPlan) => boolean | void,
  ): Promise<{ ok: boolean; plan?: SessionPlan | undefined }>;
  deletePlan(sessionId: string): Promise<void>;
}
