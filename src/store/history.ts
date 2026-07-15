import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
  chown,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ToolCall, ToolResult } from "../types.js";
import type { TranscriptItem } from "../tui/state.js";
import { redactSecrets } from "../llm/provider.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";
import { getHistoryDir } from "./paths.js";

/** Live paths so CLAI_DATA_DIR / CLAI_HISTORY_DIR always apply (and tests work). */
function historyDirPath(): string {
  return getHistoryDir();
}
function dbFilePath(): string {
  return join(historyDirPath(), "history.db");
}
function jsonlFilePath(): string {
  return join(historyDirPath(), "history.jsonl");
}
/** Sessions pruned by retention land here — never hard-deleted on autosave. */
function archiveFilePath(): string {
  return join(historyDirPath(), "history-archive.jsonl");
}
/** Rolling pre-write snapshots of the active history file. */
function backupDirPath(): string {
  return join(historyDirPath(), "history-backups");
}
/** Max rolling backups kept under history-backups/. */
const MAX_HISTORY_BACKUPS = 12;
// We keep this string here (not as a literal) so the bundler doesn't try
// to statically resolve a module that may not be installed. If a user has
// `better-sqlite3` available (eg they explicitly added it for a richer
// history experience) we'll happily use it; otherwise we transparently
// fall back to the always-available JSONL log. This lets us drop
// `better-sqlite3` from our optional dependencies — and with it the
// deprecated `prebuild-install` warning — without losing functionality
// for users who already had a SQLite-backed history.
const sqliteModuleName = "better-sqlite3";

export interface HistoryRecord {
  id: string;
  name?: string | undefined;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: ChatMessage[];
  /**
   * Optional TUI display transcript. Older records only have `messages`;
   * they still restore as user/assistant summaries.
   */
  transcript?: TranscriptItem[] | undefined;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  exitCode?: number | undefined;
  output: string;
}

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

type DatabaseCtor = new (path: string) => DatabaseLike;

let cachedDb: DatabaseLike | undefined;
let sqliteUnavailable = false;

async function loadDatabase(): Promise<DatabaseLike | undefined> {
  if (cachedDb) return cachedDb;
  if (sqliteUnavailable) return undefined;
  try {
    await mkdir(historyDirPath(), { recursive: true });
    await fixOwner(historyDirPath());
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFilePath());
    fixOwnerSync(dbFilePath());
    cachedDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        messages_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        ok INTEGER NOT NULL,
        exit_code INTEGER,
        output TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
    `);
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scrubMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { images: _images, ...rest } = message;
    // Drop image bytes from persisted history — base64 blobs would bloat the
    // store and they're not useful to replay. The text content (which
    // includes a note that an image was attached) is kept and redacted.
    return { ...rest, content: redactSecrets(message.content) };
  });
}

function scrubTranscript(items?: TranscriptItem[] | undefined): TranscriptItem[] | undefined {
  if (!items) return undefined;
  return items.map((item) => {
    switch (item.kind) {
      case "user":
        return { ...item, text: redactSecrets(item.text), done: true };
      case "assistant":
        return { ...item, text: redactSecrets(item.text), streaming: false, done: true };
      case "thinking":
        return { ...item, content: redactSecrets(item.content), done: true };
      case "tool":
        return {
          ...item,
          argsDisplay: redactSecrets(item.argsDisplay),
          output: redactSecrets(item.output),
          summary: item.summary ? redactSecrets(item.summary) : item.summary,
          status: item.status === "running" ? "ok" : item.status,
          done: true,
        };
      case "notice":
        return { ...item, text: redactSecrets(item.text), done: true };
      case "plan":
        return { ...item, done: true };
      case "compacted":
        return {
          ...item,
          summary: redactSecrets(item.summary),
          originalItems: scrubTranscript(item.originalItems) ?? [],
          done: true,
        };
    }
  });
}

async function appendJsonl(record: HistoryRecord): Promise<void> {
  await mutateJsonl((records) => {
    records.push(record);
    return records;
  });
}

/**
 * Serializes every JSONL mutation through a single promise chain so concurrent
 * autosaves never interleave a read with another writer's truncating write.
 * Without this, a reader could observe a half-written (or momentarily empty)
 * file and then persist back only its own record, wiping every other session.
 */
let jsonlWriteChain: Promise<void> = Promise.resolve();
/** Ensures orphan .tmp / archive recovery runs at most once per process. */
let recoveryAttempted = false;

function mutateJsonl(
  update: (records: HistoryRecord[]) => HistoryRecord[],
): Promise<void> {
  const run = jsonlWriteChain.then(async () => {
    try {
      await ensureHistoryRecovered();
      const current = await readJsonlRecordsFrom(jsonlFilePath());
      const next = update(current);
      await writeJsonlAtomic(next);
    } catch (err: any) {
      handlePermissionError(err);
    }
  });
  // Keep the chain alive even if this task rejects, so later writes still run.
  jsonlWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function updatedAtMs(record: HistoryRecord): number {
  const t = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

/** Keep the newest version of each session id. */
export function dedupeHistoryById(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  const byId = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!record?.id) continue;
    const prev = byId.get(record.id);
    if (!prev || updatedAtMs(record) >= updatedAtMs(prev)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

export function sortHistoryByUpdatedDesc(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  return [...records].sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
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

/** Read and parse all valid JSONL records from any path. */
async function readJsonlRecordsFrom(path: string): Promise<HistoryRecord[]> {
  if (!(await safeExists(path))) return [];
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is HistoryRecord => record !== null);
  } catch (err: any) {
    if (err && err.code === "EACCES") handlePermissionError(err);
    return [];
  }
}

async function appendRecordsToFile(
  path: string,
  records: readonly HistoryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());
  const chunk = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  // Append is best-effort durable; archive growth is unbounded by design so
  // retention never permanently loses a conversation.
  await appendFile(path, chunk, { mode: 0o600 });
  await fixOwner(path).catch(() => undefined);
}

async function backupActiveHistory(): Promise<void> {
  if (!(await safeExists(jsonlFilePath()))) return;
  try {
    await mkdir(backupDirPath(), { recursive: true });
    await fixOwner(backupDirPath());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupDirPath(), `history-${stamp}.jsonl`);
    await copyFile(jsonlFilePath(), dest);
    await fixOwner(dest).catch(() => undefined);
    // Keep only the newest N backups.
    const names = (await readdir(backupDirPath()))
      .filter((n) => n.startsWith("history-") && n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const old of names.slice(MAX_HISTORY_BACKUPS)) {
      await rm(join(backupDirPath(), old), { force: true }).catch(() => undefined);
    }
  } catch {
    // Backup is best-effort; never block the autosave path.
  }
}

/**
 * Scan leftover write temps + the archive for sessions missing from the
 * active file and merge them back. Fixes history that was pruned by the old
 * slice(-200) retention or left in .tmp after a crashed rename.
 */
export async function recoverOrphanedHistory(): Promise<{
  recovered: number;
  sources: string[];
}> {
  const sources: string[] = [];
  const extras: HistoryRecord[] = [];

  try {
    const names = await readdir(historyDirPath());
    for (const name of names) {
      // Live write temps: history.jsonl.<pid>.<stamp>.tmp
      if (
        name.startsWith("history.jsonl.") &&
        name.endsWith(".tmp")
      ) {
        const path = join(historyDirPath(), name);
        const rows = await readJsonlRecordsFrom(path);
        if (rows.length === 0) {
          // Empty crash leftovers — safe to remove.
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        extras.push(...rows);
        sources.push(name);
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  // Also fold in archive (sessions previously pruned).
  if (await safeExists(archiveFilePath())) {
    const archived = await readJsonlRecordsFrom(archiveFilePath());
    if (archived.length > 0) {
      extras.push(...archived);
      sources.push("history-archive.jsonl");
    }
  }

  // Rolling backups (last-resort recovery of wiped active files).
  try {
    if (await safeExists(backupDirPath())) {
      const backups = (await readdir(backupDirPath()))
        .filter((n) => n.startsWith("history-") && n.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const name of backups) {
        const rows = await readJsonlRecordsFrom(join(backupDirPath(), name));
        if (rows.length > 0) {
          extras.push(...rows);
          sources.push(`history-backups/${name}`);
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (extras.length === 0) return { recovered: 0, sources: [] };

  const active = await readJsonlRecordsFrom(jsonlFilePath());
  const beforeIds = new Set(active.map((r) => r.id));
  const merged = dedupeHistoryById([...active, ...extras]);
  const newCount = merged.filter((r) => !beforeIds.has(r.id)).length;
  if (newCount === 0 && merged.length <= active.length) {
    return { recovered: 0, sources };
  }

  // Write WITHOUT applying retention so recovery cannot re-prune.
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());
  if (await safeExists(jsonlFilePath())) await backupActiveHistory();
  const sorted = sortHistoryByUpdatedDesc(merged);
  // Stable chronological file order (oldest first) for append-friendly diffs.
  sorted.reverse();
  const body = sorted.length
    ? `${sorted.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const tmpFile = `${jsonlFilePath()}.recover.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmpFile, body, { mode: 0o600 });
  try {
    await rename(tmpFile, jsonlFilePath());
  } catch (err) {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
  await fixOwner(jsonlFilePath());

  // Successful recovery: drop non-empty orphan temps we already merged.
  for (const name of sources) {
    if (name.startsWith("history.jsonl.") && name.endsWith(".tmp")) {
      await rm(join(historyDirPath(), name), { force: true }).catch(() => undefined);
    }
  }

  return { recovered: newCount, sources };
}

async function ensureHistoryRecovered(): Promise<void> {
  if (recoveryAttempted) return;
  recoveryAttempted = true;
  try {
    await recoverOrphanedHistory();
  } catch {
    // Never block history reads/writes on recovery failure.
  }
}

/**
 * Apply retention (archive pruned sessions) and write the active file
 * atomically. Never hard-deletes pruned chats — they go to history-archive.jsonl.
 */
async function writeJsonlAtomic(records: HistoryRecord[]): Promise<void> {
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
    const existing = await readJsonlRecordsFrom(jsonlFilePath());
    if (kept.length < existing.length || pruned.length > 0) {
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
      const body = `${safe.map((item) => JSON.stringify(item)).join("\n")}\n`;
      const tmpFile = `${jsonlFilePath()}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmpFile, body, { mode: 0o600 });
      try {
        await rename(tmpFile, jsonlFilePath());
      } catch (err) {
        await rm(tmpFile, { force: true }).catch(() => undefined);
        throw err;
      }
      await fixOwner(jsonlFilePath());
      return;
    }
  }

  // File order: oldest → newest (matches classic append style).
  const ordered = sortHistoryByUpdatedDesc(kept);
  ordered.reverse();
  const body = ordered.length
    ? `${ordered.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const tmpFile = `${jsonlFilePath()}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  await writeFile(tmpFile, body, { mode: 0o600 });
  try {
    await rename(tmpFile, jsonlFilePath());
  } catch (err) {
    // Keep the temp file on rename failure so recovery can pick it up —
    // only remove empty temps.
    try {
      const st = await readFile(tmpFile).catch(() => null);
      if (!st || st.length === 0) {
        await rm(tmpFile, { force: true }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
    throw err;
  }
  await fixOwner(jsonlFilePath());
}

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
): Promise<HistoryRecord> {
  // Auto-derive a readable name from the first user message if none provided
  if (!name) {
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) {
      const preview = firstUser.content.slice(0, 60).replace(/\n/g, " ").trim();
      name = preview + (firstUser.content.length > 60 ? "…" : "");
    }
  }

  const now = new Date().toISOString();
  const record: HistoryRecord = {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
  };

  // Private mode: never persist chat content. Caller still gets a record
  // back (so /save echoes a usable id) but nothing hits disk.
  if (getConfig().privateMode) {
    return record;
  }

  const db = await loadDatabase();
  if (db) {
    db.prepare(
      "INSERT INTO sessions (id, name, created_at, updated_at, cwd, messages_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.name ?? null,
      record.createdAt,
      record.updatedAt,
      record.cwd,
      JSON.stringify({ messages: record.messages, transcript: record.transcript }),
    );
    await enforceSqliteRetention(db);
  } else {
    await appendJsonl(record);
  }

  return record;
}

export async function upsertSession(
  id: string,
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
): Promise<HistoryRecord> {
  const existing = await getSession(id);
  const firstUser = messages.find((m) => m.role === "user");
  const derivedName = firstUser
    ? firstUser.content.slice(0, 60).replace(/\n/g, " ").trim() + (firstUser.content.length > 60 ? "…" : "")
    : undefined;
  const now = new Date().toISOString();
  const record: HistoryRecord = {
    id,
    name: name ?? existing?.name ?? derivedName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
  };

  if (getConfig().privateMode) return record;

  const db = await loadDatabase();
  if (db) {
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, name, created_at, updated_at, cwd, messages_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.name ?? null,
      record.createdAt,
      record.updatedAt,
      record.cwd,
      JSON.stringify({ messages: record.messages, transcript: record.transcript }),
    );
    await enforceSqliteRetention(db);
  } else {
    await upsertJsonl(record);
  }

  return record;
}

async function enforceSqliteRetention(db: DatabaseLike): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  // Archive rows about to be deleted, then delete — never hard-drop without
  // a JSONL archive copy.
  try {
    const doomed = db
      .prepare(
        `SELECT id, name, created_at, updated_at, cwd, messages_json FROM sessions
         WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?)`,
      )
      .all(Math.floor(limit)) as unknown[];
    const records = doomed.map(rowToSession);
    if (records.length > 0) await appendRecordsToFile(archiveFilePath(), records);
  } catch {
    /* archive best-effort */
  }
  db.exec(
    `DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${Math.floor(limit)});`,
  );
}

async function upsertJsonl(record: HistoryRecord): Promise<void> {
  await mutateJsonl((records) => {
    const idx = records.findIndex((item) => item.id === record.id);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    return records;
  });
}

export async function saveToolCall(
  sessionId: string,
  call: ToolCall,
  result: ToolResult,
): Promise<ToolCallRecord> {
  const record: ToolCallRecord = {
    id: newId(),
    sessionId,
    createdAt: new Date().toISOString(),
    name: call.name,
    args: call.args,
    ok: result.ok,
    exitCode: result.exitCode,
    output: redactSecrets(result.output),
  };
  const db = await loadDatabase();
  if (db) {
    db.prepare(
      "INSERT INTO tool_calls (id, session_id, created_at, name, args_json, ok, exit_code, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      record.sessionId,
      record.createdAt,
      record.name,
      JSON.stringify(record.args),
      record.ok ? 1 : 0,
      record.exitCode ?? null,
      record.output,
    );
  }
  return record;
}

function rowToSession(row: unknown): HistoryRecord {
  const data = row as {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
    cwd: string;
    messages_json: string;
  };
  const parsed = JSON.parse(data.messages_json) as
    | ChatMessage[]
    | { messages?: ChatMessage[]; transcript?: TranscriptItem[] };
  const messages = Array.isArray(parsed) ? parsed : parsed.messages ?? [];
  return {
    id: data.id,
    name: data.name ?? undefined,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    cwd: data.cwd,
    messages,
    transcript: Array.isArray(parsed) ? undefined : parsed.transcript,
  };
}

async function listJsonlSessions(limit: number): Promise<HistoryRecord[]> {
  await ensureHistoryRecovered();
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

/**
 * Merge SQLite + JSONL sources so enabling better-sqlite3 never hides an
 * existing JSONL history (or vice versa). Prefer the newer updatedAt per id.
 */
function mergeSessionLists(
  ...lists: readonly (readonly HistoryRecord[])[]
): HistoryRecord[] {
  return sortHistoryByUpdatedDesc(dedupeHistoryById(lists.flat()));
}

export async function listSessions(limit = 20): Promise<HistoryRecord[]> {
  await ensureHistoryRecovered();
  const fromJsonl = await listJsonlSessions(0); // full set, already sorted
  const db = await loadDatabase();
  let fromDb: HistoryRecord[] = [];
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT id, name, created_at, updated_at, cwd, messages_json FROM sessions ORDER BY updated_at DESC",
        )
        .all();
      fromDb = rows.map(rowToSession);
    } catch {
      fromDb = [];
    }
  }
  // Active + SQLite only. Archive/pruned sessions are merged back into the
  // active file by recoverOrphanedHistory() (called on /history open), so
  // they reappear there rather than staying invisible forever.
  const merged = mergeSessionLists(fromJsonl, fromDb);
  if (!limit || limit <= 0) return merged;
  return merged.slice(0, limit);
}

export async function getSession(
  sessionId: string,
): Promise<HistoryRecord | undefined> {
  await ensureHistoryRecovered();
  const db = await loadDatabase();
  let fromDb: HistoryRecord | undefined;
  if (db) {
    const row = db
      .prepare(
        "SELECT id, name, created_at, updated_at, cwd, messages_json FROM sessions WHERE id = ?",
      )
      .get(sessionId);
    if (row) fromDb = rowToSession(row);
  }
  const fromJsonl = (await readJsonlRecordsFrom(jsonlFilePath())).find(
    (session) => session.id === sessionId,
  );
  // Also check archive for sessions pruned from the active set.
  const fromArchive = fromJsonl
    ? undefined
    : (await readJsonlRecordsFrom(archiveFilePath())).find((s) => s.id === sessionId);

  const candidates = [fromDb, fromJsonl, fromArchive].filter(
    (r): r is HistoryRecord => Boolean(r),
  );
  if (candidates.length === 0) return undefined;
  return sortHistoryByUpdatedDesc(candidates)[0];
}

export function getHistoryPath(): string {
  // Prefer JSONL as the durable path users can inspect/backup; SQLite is
  // optional acceleration when better-sqlite3 is installed.
  return jsonlFilePath();
}

/**
 * Clear active history after archiving a full snapshot. Never unrecoverably
 * destroys chats — a timestamped copy is written under history-backups/ and
 * the previous active file is moved into history-archive.jsonl.
 */
export async function clearAllHistory(): Promise<{
  cleared: boolean;
  detail: string;
}> {
  let detail = "";
  await ensureHistoryRecovered();

  // Snapshot + move aside. Do NOT write into history-archive.jsonl here —
  // that file is auto-reimported by recoverOrphanedHistory, which would
  // immediately undo a clear. Intentional clears go to history-cleared-*.jsonl
  // (and rolling backups) only.
  try {
    const snapshot = await readJsonlRecordsFrom(jsonlFilePath());
    if (snapshot.length > 0) {
      await backupActiveHistory();
      detail += `backed up ${snapshot.length} session(s); `;
    }
  } catch (error) {
    detail += `backup error: ${error instanceof Error ? error.message : String(error)}; `;
  }

  try {
    const db = await loadDatabase();
    if (db) {
      db.exec("DELETE FROM sessions; DELETE FROM tool_calls;");
      detail += "sqlite cleared; ";
    }
  } catch (error) {
    detail += `sqlite error: ${error instanceof Error ? error.message : String(error)}; `;
  }
  if (await safeExists(jsonlFilePath())) {
    try {
      // Move aside rather than unlink so crash mid-clear still leaves a file.
      const clearedCopy = join(
        historyDirPath(),
        `history-cleared-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
      );
      await rename(jsonlFilePath(), clearedCopy).catch(async () => {
        await copyFile(jsonlFilePath(), clearedCopy).catch(() => undefined);
        await rm(jsonlFilePath(), { force: true });
      });
      detail += `jsonl moved to ${clearedCopy} (recoverable)`;
    } catch (error) {
      detail += `jsonl error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // Plans live alongside history (same DB / a sibling JSONL). Clearing
  // history should clear stored plans too so nothing leaks across a reset.
  try {
    const { clearAllPlans } = await import("./plan.js");
    await clearAllPlans();
    detail += "; plans cleared";
  } catch {
    /* plan store optional */
  }
  return { cleared: true, detail: detail.trim() };
}

export function getJsonlHistoryPath(): string {
  return jsonlFilePath();
}

export function getHistoryArchivePath(): string {
  return archiveFilePath();
}

export function getHistoryBackupDir(): string {
  return backupDirPath();
}
