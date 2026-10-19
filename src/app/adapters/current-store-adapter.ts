import { pendingSessionMerge, saveSession, upsertSession, type HistoryRecord } from "../../store/history.js";
import { deletePlan, loadPlan, mutatePlan, savePlan } from "../../store/plan.js";
import type { PersistedSessionMerge, PersistencePort } from "../ports/persistence-port.js";
import type { TranscriptItem } from "../ports/transcript-item.js";

function mergedTranscript(record: HistoryRecord | undefined): PersistedSessionMerge | undefined {
  return record?.pendingMerge && record.transcript ? { transcript: record.transcript } : undefined;
}

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
        const canonical = await upsertSession(
          options.sessionId,
          list,
          options.name,
          transcript,
          contextUsage,
          options.revision,
          options.writerGeneration,
          options.previousTurn,
          sessionModel,
          options.location,
          options.changes,
          options.unsyncedItemIds,
        );
        return mergedTranscript(canonical);
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
        options?.location,
        options?.changes,
      );
    },
    pendingSessionMerge: async (sessionId) => mergedTranscript(await pendingSessionMerge(sessionId)),
    loadPlan: (sessionId) => loadPlan(sessionId),
    savePlan: (plan) => savePlan(plan),
    mutatePlan: (sessionId, reducer) => mutatePlan(sessionId, reducer),
    deletePlan: (sessionId) => deletePlan(sessionId),
  };
}
