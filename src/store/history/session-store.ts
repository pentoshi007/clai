import { rm } from "node:fs/promises";
import { handlePermissionError } from "../../os/permissions.js";
import { getConfig } from "../config.js";
import type { HistorySummary } from "../history-index.js";
import { compareHistoryFreshness } from "./freshness.js";
import { acquireStorageWriteLock } from "./jsonl-lock.js";
import { hydrateHistoryRecord, type HistoryRecord } from "./recovery.js";
import { planBaseFrame, planSessionFrame, type HistoryRecordHead, type SessionLogState } from "./session-frames.js";
import { indexEntryFor, listIndexedSessions, patchSessionIndex, readSessionIndex } from "./session-index.js";
import {
  appendSessionFrame,
  cachedSessionState,
  forgetSessionState,
  loadSessionLog,
  loadSessionStateForWrite,
  readSessionTailSummary,
  rememberSessionState,
  removeSessionDirectory,
  rewriteSessionLog,
  stampKey,
  statSessionLog,
  type LogStamp,
} from "./session-log.js";
import { sessionLockPath, sessionsDirPath } from "./session-paths.js";
import { appendRecordsToFile, archiveFilePath } from "./sqlite-backend.js";
import { mergeTranscripts } from "./transcript-merge.js";
import { partitionByRetention } from "./jsonl-backend.js";

const COMPACT_DELTA_LIMIT = 64;
const COMPACT_SLACK_BYTES = 1024 * 1024;

const writeChains = new Map<string, Promise<unknown>>();
const probedStamps = new Map<string, string>();

function queueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(sessionId) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  writeChains.set(sessionId, settled);
  void settled.then(() => {
    if (writeChains.get(sessionId) === settled) writeChains.delete(sessionId);
  });
  return run;
}

async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  return await queueSessionWrite(sessionId, async () => {
    try {
      const release = await acquireStorageWriteLock(sessionLockPath(sessionId), "session history");
      try {
        return await operation();
      } finally {
        await release();
      }
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code === "EACCES") handlePermissionError(error);
      throw error;
    }
  });
}

function freshnessOf(summary: HistorySummary): HistoryRecord & { itemCount: number } {
  return {
    id: summary.id,
    itemCount: summary.itemCount,
    writerGeneration: summary.writerGeneration,
    revision: summary.revision,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    cwd: summary.cwd,
    messages: [],
  };
}

interface Arbitration {
  readonly record: HistoryRecord;
  readonly write: boolean;
  readonly forceBase: boolean;
}

function withoutStoredItems(record: HistoryRecord, storedTranscript: number | undefined): HistoryRecord {
  const { pendingMerge: _pendingMerge, ...base } = record;
  if (record.transcript?.length) return { ...base, transcript: [...record.transcript] };
  return { ...base, transcript: storedTranscript === undefined ? undefined : [] };
}

async function arbitrate(
  record: HistoryRecord,
  existing: HistorySummary | undefined,
  storedTranscript: number | undefined,
  loadStored: () => Promise<HistoryRecord | undefined>,
): Promise<Arbitration> {
  if (!existing) return { record, write: true, forceBase: false };
  const incomingItems = record.transcript?.length ?? 0;
  const stale = compareHistoryFreshness(record, freshnessOf(existing)) <= 0;
  const changedWriter = existing.writerGeneration !== record.writerGeneration;
  const mayLoseItems = (storedTranscript ?? 0) > incomingItems;
  const pendingMerge = existing.pendingMerge === true;
  if (!(stale || changedWriter || mayLoseItems || pendingMerge)) {
    if (existing.itemCount <= incomingItems) return { record, write: true, forceBase: false };
    return { record: withoutStoredItems(record, storedTranscript), write: true, forceBase: false };
  }
  const stored = await loadStored();
  if (!stored) return { record, write: true, forceBase: true };
  const winner = stale ? stored : record;
  const loser = stale ? record : stored;
  const transcript = mergeTranscripts(winner.transcript, loser.transcript);
  if (stale && (transcript?.length ?? 0) === (stored.transcript?.length ?? 0)) {
    return { record: hydrateHistoryRecord(stored), write: false, forceBase: false };
  }
  const { pendingMerge: _pendingMerge, ...base } = winner;
  const unseen = (transcript?.length ?? 0) > (winner.transcript?.length ?? 0);
  return {
    record: { ...base, transcript, ...(unseen ? { pendingMerge: true as const } : {}) },
    write: true,
    forceBase: stale || changedWriter || unseen,
  };
}

function shouldCompact(state: SessionLogState, stamp: LogStamp): boolean {
  return state.deltaCount > COMPACT_DELTA_LIMIT || stamp.size > state.baseBytes * 2 + COMPACT_SLACK_BYTES;
}

async function writeUnderLock(incoming: HistoryRecord): Promise<{ record: HistoryRecord; summary?: HistorySummary; stamp?: LogStamp }> {
  const id = incoming.id;
  const current = await loadSessionStateForWrite(id);
  const arbitration = await arbitrate(incoming, current.state?.summary, current.state?.transcriptDigests?.length, async () => {
    const loaded = current.loaded ?? await loadSessionLog(id);
    return loaded?.replayed.record;
  });
  if (!arbitration.write) return { record: arbitration.record };
  const record = arbitration.record;
  const planned = planSessionFrame(current.state, record, { forceBase: arbitration.forceBase });
  let stamp = await appendSessionFrame(id, planned.line, current.stamp?.size ?? 0);
  let state = planned.state;
  if (shouldCompact(state, stamp)) {
    const compacted = planned.kind === "base" ? planned : planBaseFrame(state.seq, record);
    stamp = await rewriteSessionLog(id, compacted.line);
    state = compacted.state;
  }
  rememberSessionState(id, stamp, state);
  return { record, summary: state.summary, stamp };
}

async function enforceRetention(protectedId: string): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  const quick = await readSessionIndex();
  if (quick && quick.size <= limit) return;
  const indexed = await listIndexedSessions();
  if (indexed.size <= limit) return;
  const { pruned } = partitionByRetention([...indexed.values()].map((entry) => freshnessOf(entry.summary)), limit);
  for (const candidate of pruned) {
    if (candidate.id === protectedId) continue;
    await withSessionLock(candidate.id, async () => {
      const loaded = await loadSessionLog(candidate.id);
      if (loaded) await appendRecordsToFile(archiveFilePath(), [loaded.replayed.record]);
      await removeSessionDirectory(candidate.id);
      probedStamps.delete(candidate.id);
    });
    await patchSessionIndex(new Map([[candidate.id, undefined]])).catch(() => undefined);
  }
}

export async function upsertSessionRecord(record: HistoryRecord): Promise<HistoryRecord> {
  const result = await withSessionLock(record.id, () => writeUnderLock(record));
  if (result.summary && result.stamp) {
    await patchSessionIndex(new Map([[record.id, indexEntryFor(record.id, result.stamp, result.summary)]])).catch(() => undefined);
    await enforceRetention(record.id);
  }
  return result.record;
}

export async function importSessionRecord(record: HistoryRecord): Promise<boolean> {
  const result = await withSessionLock(record.id, () => writeUnderLock(record));
  if (!result.summary || !result.stamp) return false;
  await patchSessionIndex(new Map([[record.id, indexEntryFor(record.id, result.stamp, result.summary)]])).catch(() => undefined);
  return true;
}

export async function readSessionRecord(sessionId: string): Promise<HistoryRecord | undefined> {
  const loaded = await loadSessionLog(sessionId);
  return loaded ? hydrateHistoryRecord(loaded.replayed.record) : undefined;
}

export async function readSessionHead(sessionId: string): Promise<HistoryRecordHead | undefined> {
  const stamp = await statSessionLog(sessionId);
  if (!stamp) return undefined;
  const cached = cachedSessionState(sessionId, stamp);
  if (cached) return cached.head;
  const loaded = await loadSessionLog(sessionId);
  if (!loaded) return undefined;
  const { messages: _messages, transcript: _transcript, ...head } = loaded.replayed.record;
  return head;
}

export async function listStoredSummaries(): Promise<HistorySummary[]> {
  return [...(await listIndexedSessions()).values()].map((entry) => entry.summary);
}

export async function sessionMergeProbe(sessionId: string): Promise<"unchanged" | "absent" | HistorySummary> {
  const stamp = await statSessionLog(sessionId);
  if (!stamp) return "absent";
  const key = stampKey(stamp);
  if (probedStamps.get(sessionId) === key) return "unchanged";
  probedStamps.set(sessionId, key);
  const tail = await readSessionTailSummary(sessionId);
  return tail?.summary ?? "unchanged";
}

export async function removeSessionStore(sessionId: string): Promise<boolean> {
  const removed = await withSessionLock(sessionId, async () => {
    probedStamps.delete(sessionId);
    return await removeSessionDirectory(sessionId);
  });
  await patchSessionIndex(new Map([[sessionId, undefined]])).catch(() => undefined);
  return removed;
}

export async function clearSessionStore(): Promise<void> {
  forgetSessionState();
  probedStamps.clear();
  await rm(sessionsDirPath(), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
