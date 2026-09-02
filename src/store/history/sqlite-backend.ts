import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { fixOwner, fixOwnerSync, handlePermissionError } from "../../os/permissions.js";
import type { ChatMessage, ProviderId } from "../../types.js";
import { getConfig } from "../config.js";
import { historySummary } from "../history-index.js";
import type { HistorySummary } from "../history-index.js";
import { historyDirPath } from "./jsonl-lock.js";
import { HistoryRecord, historyRevision, historyWriterGeneration, hydrateHistoryRecord, PersistedContextUsage } from "./recovery.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

function dbFilePath(): string {
  return join(historyDirPath(), "history.db");
}

export function archiveFilePath(): string {
  return join(historyDirPath(), "history-archive.jsonl");
}

const sqliteModuleName = "better-sqlite3";

export interface SessionModelSelection {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
}

export function sessionModelFields(
  selection?: SessionModelSelection | undefined,
  fallback?: SessionModelSelection | undefined,
): SessionModelSelection {
  const provider = selection?.provider ?? fallback?.provider;
  const model = selection?.model ?? fallback?.model;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
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

export async function loadDatabase(): Promise<DatabaseLike | undefined> {
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
        writer_generation TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        has_images INTEGER NOT NULL DEFAULT 0,
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
    const sessionColumns = cachedDb
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name?: string }>;
    if (!sessionColumns.some((column) => column.name === "writer_generation")) {
      cachedDb.exec("ALTER TABLE sessions ADD COLUMN writer_generation TEXT;");
    }
    if (!sessionColumns.some((column) => column.name === "revision")) {
      cachedDb.exec(
        "ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;",
      );
    }
    if (!sessionColumns.some((column) => column.name === "message_count")) {
      cachedDb.exec(
        "ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;",
      );
    }
    if (!sessionColumns.some((column) => column.name === "item_count")) {
      cachedDb.exec(
        "ALTER TABLE sessions ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;",
      );
    }
    if (!sessionColumns.some((column) => column.name === "has_images")) {
      cachedDb.exec(
        "ALTER TABLE sessions ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0;",
      );
    }
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

export async function appendRecordsToFile(
  path: string,
  records: readonly HistoryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(historyDirPath(), { recursive: true });
  await fixOwner(historyDirPath());
  const chunk = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await appendFile(path, chunk, { mode: 0o600 });
  await fixOwner(path).catch(() => undefined);
}

function serializeSessionPayload(record: HistoryRecord): string {
  return JSON.stringify({
    messages: record.messages,
    transcript: record.transcript,
    ...(record.contextUsage ? { contextUsage: record.contextUsage } : {}),
    ...(record.previousTurn ? { previousTurn: record.previousTurn } : {}),
    ...sessionModelFields(record),
    ...(record.workspaceFolder
      ? {
          workspaceFolder: record.workspaceFolder,
          workspaceCode: record.workspaceCode,
        }
      : {}),
  });
}

export function upsertSqlite(db: DatabaseLike, record: HistoryRecord): void {
  const summary = historySummary(record);
  db.prepare(
    `INSERT INTO sessions
       (id, name, created_at, updated_at, writer_generation, revision, cwd,
        message_count, item_count, has_images, messages_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       writer_generation = excluded.writer_generation,
       revision = excluded.revision,
       cwd = excluded.cwd,
       message_count = excluded.message_count,
       item_count = excluded.item_count,
       has_images = excluded.has_images,
       messages_json = excluded.messages_json
     WHERE (sessions.writer_generation IS NULL AND excluded.writer_generation IS NOT NULL)
        OR excluded.writer_generation > sessions.writer_generation
        OR (excluded.writer_generation = sessions.writer_generation
            AND excluded.revision >= sessions.revision)
        OR (sessions.writer_generation IS NULL AND excluded.writer_generation IS NULL
            AND excluded.revision >= sessions.revision)`,
  ).run(
    record.id,
    record.name ?? null,
    record.createdAt,
    record.updatedAt,
    historyWriterGeneration(record) ?? null,
    historyRevision(record),
    record.cwd,
    summary.messageCount,
    summary.itemCount,
    summary.hasImages ? 1 : 0,
    serializeSessionPayload(record),
  );
}

export async function enforceSqliteRetention(db: DatabaseLike): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  try {
    const doomed = db
      .prepare(
        `SELECT id, name, created_at, updated_at, writer_generation, revision, cwd, messages_json FROM sessions
         WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?)`,
      )
      .all(Math.floor(limit)) as unknown[];
    const records = doomed.map(rowToSession);
    if (records.length > 0) await appendRecordsToFile(archiveFilePath(), records);
  } catch {
  }
  db.exec(
    `DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${Math.floor(limit)});`,
  );
}

export function rowToSession(row: unknown): HistoryRecord {
  const data = row as {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
    writer_generation?: string | null | undefined;
    revision?: number | undefined;
    cwd: string;
    messages_json: string;
  };
  const parsed = JSON.parse(data.messages_json) as
    | ChatMessage[]
    | {
        messages?: ChatMessage[];
        transcript?: TranscriptItem[];
        contextUsage?: PersistedContextUsage;
        previousTurn?: PreviousTurnSignal;
        provider?: ProviderId;
        model?: string;
        workspaceFolder?: string;
        workspaceCode?: string;
      };
  type SessionPayload = Exclude<typeof parsed, ChatMessage[]>;
  let payload: SessionPayload = {};
  let messages: ChatMessage[];
  if (Array.isArray(parsed)) {
    messages = parsed;
  } else {
    payload = parsed;
    messages = parsed.messages ?? [];
  }
  return hydrateHistoryRecord({
    id: data.id,
    writerGeneration: data.writer_generation ?? undefined,
    revision:
      typeof data.revision === "number" && data.revision > 0
        ? data.revision
        : undefined,
    name: data.name ?? undefined,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    cwd: data.cwd,
    messages,
    transcript: payload.transcript,
    contextUsage: payload.contextUsage,
    previousTurn: payload.previousTurn,
    provider: payload.provider,
    model: payload.model,
    workspaceFolder: payload.workspaceFolder,
    workspaceCode: payload.workspaceCode,
  });
}

export function rowToSummary(row: unknown): HistorySummary {
  const data = row as {
    id: string;
    name: string | null;
    created_at: string;
    updated_at: string;
    writer_generation?: string | null | undefined;
    revision?: number | undefined;
    cwd: string;
    message_count?: number | undefined;
    item_count?: number | undefined;
    has_images?: number | undefined;
  };
  return {
    id: data.id,
    ...(data.writer_generation
      ? { writerGeneration: data.writer_generation }
      : {}),
    ...(typeof data.revision === "number" && data.revision > 0
      ? { revision: data.revision }
      : {}),
    ...(data.name ? { name: data.name } : {}),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    cwd: data.cwd,
    messageCount: Math.max(0, data.message_count ?? 0),
    itemCount: Math.max(0, data.item_count ?? data.message_count ?? 0),
    hasImages: data.has_images === 1,
  };
}
