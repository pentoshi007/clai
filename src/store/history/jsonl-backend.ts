import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import { getConfig } from "../config.js";
import { appendIndexedHistoryRecord, readIndexedHistoryRecord, readValidatedHistoryIndex, writeIndexedJsonl } from "../history-index.js";
import type { HistoryIndexEntry, HistorySummary } from "../history-index.js";
import { acquireJsonlWriteLock, historyDirPath } from "./jsonl-lock.js";
import { backupActiveHistory, compareHistoryFreshness, dedupeHistoryById, ensureHistoryRecovered, HistoryRecord, hydrateHistoryRecord, invalidateSessionListCache, jsonlFilePath, jsonlIndexFilePath, readJsonlRecordsFrom, sortHistoryByUpdatedDesc } from "./recovery.js";
import { appendRecordsToFile, archiveFilePath } from "./sqlite-backend.js";
import { mkdir } from "node:fs/promises";

/**
 * Serializes every JSONL mutation through a single promise chain so concurrent
 * autosaves never interleave a read with another writer's truncating write.
 * Without this, a reader could observe a half-written (or momentarily empty)
 * file and then persist back only its own record, wiping every other session.
 */
let jsonlWriteChain: Promise<void> = Promise.resolve();

/** Queue a locked JSONL section; the chain survives individual failures. */
export function queueJsonlWrite<T>(
  operation: () => Promise<T>,
  fallback: () => T,
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
        // A list may have been loaded after the pre-write invalidation but
        // before the atomic rename completed. Never leave that snapshot cached.
        invalidateSessionListCache();
      }
    } catch (err: any) {
      handlePermissionError(err);
      return fallback();
    }
  });
  jsonlWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function mutateJsonl(
  update: (records: HistoryRecord[]) => HistoryRecord[],
): Promise<void> {
  return queueJsonlWrite(async () => {
    const current = await readJsonlRecordsFrom(jsonlFilePath());
    await writeJsonlAtomic(update(current), current.length);
  }, () => undefined);
}

/**
 * Apply retention by *recency* (not file order). Pruned sessions are returned
 * separately so callers can archive them — never silently destroy history.
 * limit <= 0 means unlimited (keep everything).
 */
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

/** Session count without parsing the whole file when the index is valid. */
async function countJsonlSessions(): Promise<number> {
  const entries = await readValidatedHistoryIndex(
    jsonlFilePath(),
    jsonlIndexFilePath(),
  );
  if (entries) return entries.length;
  return (await readJsonlRecordsFrom(jsonlFilePath())).length;
}

/**
 * Apply retention (archive pruned sessions) and write the active file
 * atomically. Never hard-deletes pruned chats — they go to history-archive.jsonl.
 */
async function writeJsonlAtomic(
  records: HistoryRecord[],
  knownExistingCount?: number,
): Promise<void> {
  invalidateSessionListCache();
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());

  const limit = getConfig().historyRetentionLimit;
  const { kept, pruned } = partitionByRetention(records, limit);

  if (pruned.length > 0) {
    // Durable archive before the active file shrinks.
    await appendRecordsToFile(archiveFilePath(), pruned);
  }

  // If we would shrink (or replace) the on-disk set, snapshot first.
  if (await safeExists(jsonlFilePath())) {
    const existingCount =
      knownExistingCount ?? (await countJsonlSessions());
    if (kept.length < existingCount || pruned.length > 0) {
      await backupActiveHistory();
    }
  }

  // Refuse to write an empty file over a non-empty one unless the caller
  // intentionally has zero records (e.g. clear after archiving).
  if (kept.length === 0 && (await safeExists(jsonlFilePath()))) {
    const existing = await readJsonlRecordsFrom(jsonlFilePath());
    if (existing.length > 0 && records.length > 0) {
      // Something went wrong in partitioning — keep the safer set.
      const safe = sortHistoryByUpdatedDesc(dedupeHistoryById(existing));
      safe.reverse();
      await writeIndexedJsonl(
        jsonlFilePath(),
        jsonlIndexFilePath(),
        safe,
      );
      await Promise.all([
        fixOwner(jsonlFilePath()),
        fixOwner(jsonlIndexFilePath()),
      ]);
      return;
    }
  }

  // File order: oldest → newest (matches classic append style).
  const ordered = sortHistoryByUpdatedDesc(kept);
  ordered.reverse();
  await writeIndexedJsonl(jsonlFilePath(), jsonlIndexFilePath(), ordered);
  await Promise.all([
    fixOwner(jsonlFilePath()),
    fixOwner(jsonlIndexFilePath()),
  ]);
}

/** Below this size a full rewrite is cheap enough to skip compaction. */
const HISTORY_COMPACT_MIN_BYTES = 1_000_000;

/** Compact once dead (superseded) lines dominate the active file. */
const HISTORY_COMPACT_LIVE_RATIO = 0.6;

function summaryFreshness(summary: HistorySummary): HistoryRecord {
  return {
    id: summary.id,
    writerGeneration: summary.writerGeneration,
    revision: summary.revision,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    cwd: summary.cwd,
    messages: [],
  };
}

function shouldCompactHistory(result: {
  entries: readonly HistoryIndexEntry[];
  fileSize: number;
  liveBytes: number;
}): boolean {
  const limit = getConfig().historyRetentionLimit;
  if (limit > 0 && result.entries.length > limit) return true;
  if (result.fileSize < HISTORY_COMPACT_MIN_BYTES) return false;
  return result.liveBytes / result.fileSize < HISTORY_COMPACT_LIVE_RATIO;
}

async function compactJsonlUnderLock(): Promise<void> {
  const records = await readJsonlRecordsFrom(jsonlFilePath());
  await writeJsonlAtomic(records, records.length);
}

async function upsertJsonlUnderLock(
  record: HistoryRecord,
): Promise<HistoryRecord> {
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());

  const entries = await readValidatedHistoryIndex(
    jsonlFilePath(),
    jsonlIndexFilePath(),
  );
  if (!entries) {
    const current = await readJsonlRecordsFrom(jsonlFilePath());
    const index = current.findIndex((item) => item.id === record.id);
    const existing = index >= 0 ? current[index] : undefined;
    if (existing && compareHistoryFreshness(record, existing) <= 0) {
      return existing;
    }
    if (index >= 0) current[index] = record;
    else current.push(record);
    await writeJsonlAtomic(current, current.length);
    return record;
  }

  const existingEntry = entries.find((entry) => entry.id === record.id);
  if (
    existingEntry &&
    compareHistoryFreshness(record, summaryFreshness(existingEntry.summary)) <= 0
  ) {
    const stored = await readIndexedHistoryRecord<HistoryRecord>(
      jsonlFilePath(),
      existingEntry,
    );
    if (stored) return hydrateHistoryRecord(stored);
  }

  const result = await appendIndexedHistoryRecord(
    jsonlFilePath(),
    jsonlIndexFilePath(),
    entries,
    record,
  );
  await Promise.all([
    fixOwner(jsonlFilePath()).catch(() => undefined),
    fixOwner(jsonlIndexFilePath()).catch(() => undefined),
  ]);
  if (shouldCompactHistory(result)) await compactJsonlUnderLock();
  return record;
}

export async function upsertJsonl(record: HistoryRecord): Promise<HistoryRecord> {
  return queueJsonlWrite(
    () => upsertJsonlUnderLock(record),
    () => record,
  );
}
