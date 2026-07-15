import { saveSession, upsertSession } from "../../store/history.js";
import { deletePlan, loadPlan, savePlan } from "../../store/plan.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { TranscriptItem } from "../../tui/state.js";

/** Backs `PersistencePort` with the existing history + plan stores. */
export function createCurrentPersistencePort(): PersistencePort {
  return {
    async saveSession(messages, options) {
      const list = [...messages];
      const transcript = options?.transcript
        ? ([...options.transcript] as TranscriptItem[])
        : undefined;
      if (options?.sessionId) {
        await upsertSession(options.sessionId, list, options.name, transcript);
        return;
      }
      await saveSession(list, options?.name, transcript);
    },
    loadPlan: (sessionId) => loadPlan(sessionId),
    savePlan: (plan) => savePlan(plan),
    deletePlan: (sessionId) => deletePlan(sessionId),
  };
}
