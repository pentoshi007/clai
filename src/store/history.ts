import { mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChatMessage, ToolCall, ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { getConfig } from "./config.js";

const historyDir = join(homedir(), ".clai");
const dbFile = join(historyDir, "history.db");
const jsonlFile = join(historyDir, "history.jsonl");
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
    await mkdir(historyDir, { recursive: true });
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFile);
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
  } catch {
    sqliteUnavailable = true;
    return undefined;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scrubMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: redactSecrets(message.content),
  }));
}

async function appendJsonl(record: HistoryRecord): Promise<void> {
  await mkdir(historyDir, { recursive: true });
  await appendFile(jsonlFile, `${JSON.stringify(record)}\n`, "utf8");
  await enforceJsonlRetention();
}

async function enforceJsonlRetention(): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  if (!existsSync(jsonlFile)) return;
  const raw = await readFile(jsonlFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= limit) return;
  const trimmed = lines.slice(-limit).join("\n");
  await writeFile(jsonlFile, `${trimmed}\n`, { mode: 0o600 });
}

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
): Promise<HistoryRecord> {
  const now = new Date().toISOString();
  const record: HistoryRecord = {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    cwd: process.cwd(),
    messages: scrubMessages(messages),
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
      JSON.stringify(record.messages),
    );
    await enforceSqliteRetention(db);
  } else {
    await appendJsonl(record);
  }

  return record;
}

async function enforceSqliteRetention(db: DatabaseLike): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  db.exec(
    `DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${Math.floor(limit)});`,
  );
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
  return {
    id: data.id,
    name: data.name ?? undefined,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    cwd: data.cwd,
    messages: JSON.parse(data.messages_json) as ChatMessage[],
  };
}

async function listJsonlSessions(limit: number): Promise<HistoryRecord[]> {
  if (!existsSync(jsonlFile)) return [];
  const raw = await readFile(jsonlFile, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryRecord)
    .slice(-limit)
    .reverse();
}

export async function listSessions(limit = 20): Promise<HistoryRecord[]> {
  const db = await loadDatabase();
  if (!db) return listJsonlSessions(limit);
  const rows = db
    .prepare(
      "SELECT id, name, created_at, updated_at, cwd, messages_json FROM sessions ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit);
  return rows.map(rowToSession);
}

export async function getSession(
  sessionId: string,
): Promise<HistoryRecord | undefined> {
  const db = await loadDatabase();
  if (!db) {
    return (await listJsonlSessions(Number.MAX_SAFE_INTEGER)).find(
      (session) => session.id === sessionId,
    );
  }
  const row = db
    .prepare(
      "SELECT id, name, created_at, updated_at, cwd, messages_json FROM sessions WHERE id = ?",
    )
    .get(sessionId);
  return row ? rowToSession(row) : undefined;
}

export function getHistoryPath(): string {
  return sqliteUnavailable ? jsonlFile : dbFile;
}

/**
 * Clear all stored history. Returns whether the operation succeeded.
 * Used by the /privacy slash command and `clai privacy clear-history`.
 */
export async function clearAllHistory(): Promise<{
  cleared: boolean;
  detail: string;
}> {
  let detail = "";
  try {
    const db = await loadDatabase();
    if (db) {
      db.exec("DELETE FROM sessions; DELETE FROM tool_calls;");
      detail += "sqlite cleared; ";
    }
  } catch (error) {
    detail += `sqlite error: ${error instanceof Error ? error.message : String(error)}; `;
  }
  if (existsSync(jsonlFile)) {
    try {
      await rm(jsonlFile, { force: true });
      detail += "jsonl removed";
    } catch (error) {
      detail += `jsonl error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { cleared: true, detail: detail.trim() };
}

export function getJsonlHistoryPath(): string {
  return jsonlFile;
}
