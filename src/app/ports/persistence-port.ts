import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";

/**
 * Session/plan persistence (CORE-005, F-008). Kept narrow so controllers depend
 * on behavior, not on the SQLite/JSONL storage details in src/store.
 */
export interface PersistencePort {
  saveSession(messages: readonly ChatMessage[]): Promise<void>;
  loadPlan(sessionId: string): Promise<SessionPlan | undefined>;
  savePlan(plan: SessionPlan): Promise<void>;
  deletePlan(sessionId: string): Promise<void>;
}
