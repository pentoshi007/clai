import { handlePermissionError } from "../../os/permissions.js";
import { findHistoryRecordStreaming, readIndexedHistoryRecord, readValidatedHistoryIndex, rebuildHistoryIndex } from "../history-index.js";
import type { HistorySummary } from "../history-index.js";
import { historyDirPath } from "./jsonl-lock.js";
import { cachedSessionList, dedupeHistoryById, ensureHistoryRecovered, HistoryRecord, hydrateHistoryRecord, jsonlFilePath, jsonlIndexFilePath, readJsonlRecordsFrom, sessionListGeneration, setCachedSessionList, sortHistoryByUpdatedDesc, startHistoryRecovery } from "./recovery.js";
import { archiveFilePath, loadDatabase, rowToSession, rowToSummary } from "./sqlite-backend.js";

/** Keep repeated /history opens fast while bounding cross-process staleness. */
const SESSION_LIST_CACHE_TTL_MS = 1_000;

function sortSummaries(summaries: readonly HistorySummary[]): HistorySummary[] {
  return [...summaries].sort(
    (left, right) =>
      Date.parse(right.updatedAt || right.createdAt) -
      Date.parse(left.updatedAt || left.createdAt),
  );
}

export async function listSessionSummaries(
  limit = 20,
  options: { recovery?: "blocking" | "background" } = {},
): Promise<HistorySummary[]> {
  if (options.recovery === "blocking") await ensureHistoryRecovered();
  else void startHistoryRecovery();

  const cacheKey = historyDirPath();
  const requestedLimit = limit > 0 ? Math.floor(limit) : 0;
  const now = Date.now();
  if (
    cachedSessionList?.historyDir === cacheKey &&
    now - cachedSessionList.cachedAt <= SESSION_LIST_CACHE_TTL_MS &&
    (cachedSessionList.coversAll ||
      (requestedLimit > 0 &&
        requestedLimit <= cachedSessionList.summaries.length))
  ) {
    const cached = cachedSessionList.summaries;
    return requestedLimit > 0 ? cached.slice(0, requestedLimit) : [...cached];
  }

  const loadGeneration = sessionListGeneration;
  let summaries: HistorySummary[] | undefined;
  let coversAll = false;
  const entries = await readValidatedHistoryIndex(
    jsonlFilePath(),
    jsonlIndexFilePath(),
  );
  if (entries) {
    summaries = sortSummaries(entries.map((entry) => entry.summary));
    coversAll = true;
  }

  if (!summaries) {
    const db = await loadDatabase();
    if (db) {
      try {
        const sql =
          "SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, " +
          "message_count, item_count, has_images FROM sessions " +
          "ORDER BY updated_at DESC" +
          (requestedLimit > 0 ? " LIMIT ?" : "");
        const rows = requestedLimit > 0
          ? db.prepare(sql).all(requestedLimit)
          : db.prepare(sql).all();
        summaries = rows.map(rowToSummary);
        coversAll = requestedLimit === 0 || rows.length < requestedLimit;
      } catch {
        summaries = undefined;
      }
    }
  }

  if (!summaries || summaries.length === 0) {
    const rebuilt = await rebuildHistoryIndex<HistoryRecord>(
      jsonlFilePath(),
      jsonlIndexFilePath(),
    );
    summaries = sortSummaries(rebuilt.map((entry) => entry.summary));
    coversAll = true;
  } else {
    void rebuildHistoryIndex<HistoryRecord>(
      jsonlFilePath(),
      jsonlIndexFilePath(),
    );
  }

  if (sessionListGeneration === loadGeneration) {
    setCachedSessionList({
      historyDir: cacheKey,
      summaries,
      cachedAt: Date.now(),
      coversAll,
    });
  }
  return requestedLimit > 0 ? summaries.slice(0, requestedLimit) : [...summaries];
}

async function listJsonlSessions(limit: number): Promise<HistoryRecord[]> {
  try {
    const records = sortHistoryByUpdatedDesc(
      dedupeHistoryById(await readJsonlRecordsFrom(jsonlFilePath())),
    );
    if (!limit || limit <= 0) return records;
    return records.slice(0, limit);
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}

function mergeSessionLists(
  ...lists: readonly (readonly HistoryRecord[])[]
): HistoryRecord[] {
  return sortHistoryByUpdatedDesc(dedupeHistoryById(lists.flat()));
}

export async function listSessions(
  limit = 20,
  options: { recovery?: "blocking" | "background" } = {},
): Promise<HistoryRecord[]> {
  if (options.recovery === "background") void startHistoryRecovery();
  else await ensureHistoryRecovered();

  const [fromJsonl, db] = await Promise.all([
    listJsonlSessions(0),
    loadDatabase(),
  ]);
  let fromDb: HistoryRecord[] = [];
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions ORDER BY updated_at DESC",
        )
        .all();
      fromDb = rows.map(rowToSession);
    } catch {
      fromDb = [];
    }
  }
  const merged = mergeSessionLists(fromJsonl, fromDb);
  return !limit || limit <= 0 ? merged : merged.slice(0, limit);
}

export async function getSession(
  sessionId: string,
): Promise<HistoryRecord | undefined> {
  void startHistoryRecovery();

  const entries = await readValidatedHistoryIndex(
    jsonlFilePath(),
    jsonlIndexFilePath(),
  );
  const entry = entries?.find((candidate) => candidate.id === sessionId);
  if (entry) {
    const indexed = await readIndexedHistoryRecord<HistoryRecord>(
      jsonlFilePath(),
      entry,
    );
    if (indexed) return hydrateHistoryRecord(indexed);
  }

  const db = await loadDatabase();
  if (db) {
    try {
      const row = db
        .prepare(
          "SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions WHERE id = ?",
        )
        .get(sessionId);
      if (row) return rowToSession(row);
    } catch {
      // Fall through to streaming JSONL lookup.
    }
  }

  const active = await findHistoryRecordStreaming<HistoryRecord>(
    jsonlFilePath(),
    sessionId,
  );
  if (active) {
    void rebuildHistoryIndex<HistoryRecord>(
      jsonlFilePath(),
      jsonlIndexFilePath(),
    );
    return hydrateHistoryRecord(active);
  }
  const archived = await findHistoryRecordStreaming<HistoryRecord>(
    archiveFilePath(),
    sessionId,
  );
  return archived ? hydrateHistoryRecord(archived) : undefined;
}
