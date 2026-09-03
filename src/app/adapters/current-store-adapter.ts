import { saveSession, upsertSession } from "../../store/history.js";
import { deletePlan, loadPlan, mutatePlan, savePlan } from "../../store/plan.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { TranscriptItem } from "../ports/transcript-item.js";

export function createCurrentPersistencePort(): PersistencePort {
  return {
    async saveSession(messages, options) {
      const list = [...messages];
      const transcript = options?.transcript
        ? ([...options.transcript] as TranscriptItem[])
        : undefined;
      const contextUsage = options?.contextUsage;
      const sessionModel =
        options?.provider || options?.model || options?.thinking
          ? {
              ...(options.provider ? { provider: options.provider } : {}),
              ...(options.model ? { model: options.model } : {}),
              ...(options.thinking ? { thinking: { ...options.thinking } } : {}),
            }
          : undefined;
      if (options?.sessionId) {
        await upsertSession(
          options.sessionId,
          list,
          options.name,
          transcript,
          contextUsage,
          options.revision,
          options.writerGeneration,
          options.previousTurn,
          sessionModel,
        );
        return;
      }
      await saveSession(
        list,
        options?.name,
        transcript,
        contextUsage,
        options?.revision,
        options?.writerGeneration,
        options?.previousTurn,
        sessionModel,
      );
    },
    loadPlan: (sessionId) => loadPlan(sessionId),
    savePlan: (plan) => savePlan(plan),
    mutatePlan: (sessionId, reducer) => mutatePlan(sessionId, reducer),
    deletePlan: (sessionId) => deletePlan(sessionId),
  };
}
