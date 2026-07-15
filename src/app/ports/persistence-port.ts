import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { TranscriptItem } from "../../tui/state.js";

export interface SaveSessionOptions {
  /** When set, upsert this session id (continuous autosave) instead of minting a new row. */
  readonly sessionId?: string | undefined;
  /** Optional display name. */
  readonly name?: string | undefined;
  /** Classic-shaped visual transcript for full /history restore. */
  readonly transcript?: readonly TranscriptItem[] | undefined;
}

/**
 * Session/plan persistence (CORE-005, F-008). Kept narrow so controllers depend
 * on behavior, not on the SQLite/JSONL storage details in src/store.
 */
export interface PersistencePort {
  saveSession(
    messages: readonly ChatMessage[],
    options?: SaveSessionOptions,
  ): Promise<void>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  deletePlan(sessionId: string): Promise<void>;
}
