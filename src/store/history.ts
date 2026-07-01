import { mkdir, readFile, rm, writeFile, chown, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChatMessage, ToolCall, ToolResult } from "../types.js";
import type { TranscriptItem } from "../tui/state.js";
import { redactSecrets } from "../llm/provider.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";

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
    await mkdir(historyDir, { recursive: true });
    await fixOwner(historyDir);
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFile);
    fixOwnerSync(dbFile);
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

function mutateJsonl(
  update: (records: HistoryRecord[]) => HistoryRecord[],
): Promise<void> {
  const run = jsonlWriteChain.then(async () => {
    try {
      const current = await readJsonlRecords();
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

/** Read and parse all valid JSONL records, silently skipping malformed lines. */
async function readJsonlRecords(): Promise<HistoryRecord[]> {
  if (!(await safeExists(jsonlFile))) return [];
  const raw = await readFile(jsonlFile, "utf8");
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
}

/**
 * Apply retention and write the whole file atomically: write a temp file and
 * rename it over the target. `rename` is atomic on the same filesystem, so a
 * concurrent reader sees either the old file or the new one — never a partial.
 */
async function writeJsonlAtomic(records: HistoryRecord[]): Promise<void> {
  await mkdir(historyDir, { recursive: true });
  await fixOwner(historyDir);
  const limit = getConfig().historyRetentionLimit;
  const kept = limit && limit > 0 ? records.slice(-limit) : records;
  const body = kept.length
    ? `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
  const tmpFile = `${jsonlFile}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  await writeFile(tmpFile, body, { mode: 0o600 });
  try {
    await rename(tmpFile, jsonlFile);
  } catch (err) {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw err;
  }
  await fixOwner(jsonlFile);
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
  if (!(await safeExists(jsonlFile))) return [];
  try {
    const raw = await readFile(jsonlFile, "utf8");
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
      .filter((record): record is HistoryRecord => record !== null)
      .slice(-limit)
      .reverse();
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
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
  if (await safeExists(jsonlFile)) {
    try {
      await rm(jsonlFile, { force: true });
      detail += "jsonl removed";
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
  return jsonlFile;
}
