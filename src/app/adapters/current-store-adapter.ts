import { saveSession } from "../../store/history.js";
import { deletePlan, loadPlan, savePlan } from "../../store/plan.js";
import type { PersistencePort } from "../ports/persistence-port.js";

/** Backs `PersistencePort` with the existing history + plan stores. */
export function createCurrentPersistencePort(): PersistencePort {
  return {
    async saveSession(messages) {
      await saveSession([...messages]);
    },
    loadPlan: (sessionId) => loadPlan(sessionId),
    savePlan: (plan) => savePlan(plan),
    deletePlan: (sessionId) => deletePlan(sessionId),
  };
}
