import { handlePermissionError } from "../../os/permissions.js";
import { acquireJsonlWriteLock } from "./jsonl-lock.js";
import { dedupeHistoryById, ensureHistoryRecovered, HistoryRecord, invalidateSessionListCache, sortHistoryByUpdatedDesc } from "./recovery.js";

let jsonlWriteChain: Promise<void> = Promise.resolve();

export function queueJsonlWrite<T>(
  operation: () => Promise<T>,
  fallback: (error: unknown) => T,
): Promise<T> {
  invalidateSessionListCache();
  const run = jsonlWriteChain.then(async () => {
    try {
      await ensureHistoryRecovered();
      const releaseLock = await acquireJsonlWriteLock();
      try {
        return await operation();
      } finally {
        await releaseLock();
        invalidateSessionListCache();
      }
    } catch (err: any) {
      if (err?.code === "EACCES") handlePermissionError(err);
      return fallback(err);
    }
  });
  jsonlWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function partitionByRetention(
  records: readonly HistoryRecord[],
  limit: number,
): { kept: HistoryRecord[]; pruned: HistoryRecord[] } {
  const unique = sortHistoryByUpdatedDesc(dedupeHistoryById(records));
  if (!limit || limit <= 0 || unique.length <= limit) {
    return { kept: unique, pruned: [] };
  }
  return {
    kept: unique.slice(0, limit),
    pruned: unique.slice(limit),
  };
}
