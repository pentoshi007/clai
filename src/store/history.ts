import { readFileSync, statSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
  chown,
} from "node:fs/promises";
import { join } from "node:path";
import {
  isInternalChatMessage,
  type ChatImage,
  type ChatMessage,
  type ToolCall,
  type ToolResult,
} from "../types.js";
import {
  imageBudgetFor,
  type ImageBudget,
} from "../attachments/image-content.js";
import { prepareImageForModel } from "../attachments/image-prepare.js";
import type { TranscriptItem } from "../tui/state.js";
import type { PreviousTurnSignal } from "../agent/continue-orient.js";
import { redactSecrets } from "../llm/provider.js";
import { redactSecretsCached } from "./redaction-cache.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";
import { getHistoryDir } from "./paths.js";
import { getActiveSessionWorkspace } from "./session-workspace.js";
import {
  appendIndexedHistoryRecord,
  findHistoryRecordStreaming,
  historySummary,
  readIndexedHistoryRecord,
  readValidatedHistoryIndex,
  rebuildHistoryIndex,
  writeIndexedJsonl,
  type HistoryIndexEntry,
  type HistorySummary,
} from "./history-index.js";

export type { HistorySummary } from "./history-index.js";

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
function jsonlIndexFilePath(): string {
  return join(historyDirPath(), "history.index.json");
}
function jsonlLockFilePath(): string {
  return join(historyDirPath(), "history.jsonl.lock");
}
function jsonlLockReaperPath(): string {
  return join(historyDirPath(), "history.jsonl.lock.reaper");
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

const sqliteModuleName = "better-sqlite3";

/** Persisted token/context footer snapshot (survives /history resume). */
export interface PersistedContextUsage {
  contextTokens: number;
  contextLimit?: number | undefined;
  lastCompletionTokens?: number | undefined;
  sessionPromptTokens?: number | undefined;
  sessionCompletionTokens?: number | undefined;
  exact: boolean;
}

export interface HistoryRecord {
  id: string;
  /** Unique writer generation, compared before the per-writer revision. */
  writerGeneration?: string | undefined;
  /**
   * Monotonic whole-snapshot revision within one writer generation. Unlike
   * updatedAt, this records capture order rather than I/O completion order.
   */
  revision?: number | undefined;
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
  /**
   * Last known context fill (prefer exact API usage). Without this, resume
   * falls back to a cheap estimate that under-counts vs live turns.
   */
  contextUsage?: PersistedContextUsage | undefined;
  /** Last settled outcome, or an interrupted in-flight turn, for restart recovery. */
  previousTurn?: PreviousTurnSignal | undefined;
  /**
   * Session workspace folder name under `{tmpdir}/clai/`
   * (e.g. `a3f9c1-18-07-2026-14-24-23`). Bound on resume so scratch +
   * tool outputs stay isolated per history session.
   */
  workspaceFolder?: string | undefined;
  /** 6-digit hex code that prefixes {@link workspaceFolder}. */
  workspaceCode?: string | undefined;
}

/** Snapshot the active session workspace for history persistence. */
function workspaceFieldsFromActive(existing?: HistoryRecord): {
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
} {
  // Prefer the already-persisted folder so rebinding mid-session never
  // renames a live workspace out from under open artifact paths.
  if (existing?.workspaceFolder) {
    return {
      workspaceFolder: existing.workspaceFolder,
      workspaceCode: existing.workspaceCode,
    };
  }
  const active = getActiveSessionWorkspace();
  if (active) {
    return {
      workspaceFolder: active.folderName,
      workspaceCode: active.code,
    };
  }
  return {};
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
let cachedSessionList:
  | {
      historyDir: string;
      summaries: HistorySummary[];
      cachedAt: number;
      coversAll: boolean;
    }
  | undefined;
let sessionListGeneration = 0;
/** Keep repeated /history opens fast while bounding cross-process staleness. */
const SESSION_LIST_CACHE_TTL_MS = 1_000;

function invalidateSessionListCache(): void {
  sessionListGeneration += 1;
  cachedSessionList = undefined;
}

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

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scrubMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { images, ...rest } = message;
    const persistedImages = images?.flatMap((image): ChatImage[] =>
      image.path
        ? [{ mediaType: image.mediaType, dataBase64: "", path: image.path }]
        : [],
    );
    return {
      ...rest,
      content: redactSecretsCached(message.content),
      ...(persistedImages?.length ? { images: persistedImages } : {}),
    };
  });
}

const MAX_RESTORED_IMAGE_COUNT = 6;

export function materializeHistoryImages(
  messages: readonly ChatMessage[],
  budget: ImageBudget = imageBudgetFor(""),
): ChatMessage[] {
  let imageCount = 0;
  let totalBytes = 0;
  const maxCount = Math.min(MAX_RESTORED_IMAGE_COUNT, budget.maxCount);
  const maxTotalBytes = budget.maxTotalBytes;
  return messages.map((message) => {
    if (!message.images?.length) return { ...message };
    const images = message.images.flatMap((image): ChatImage[] => {
      if (image.dataBase64) return [image];
      if (!image.path || imageCount >= maxCount) return [];
      const prepared = prepareImageForModel(image.path, budget);
      if (!prepared.ok) return [];
      if (totalBytes + prepared.byteLength > maxTotalBytes) return [];
      try {
        const bytes = readFileSync(prepared.path);
        imageCount += 1;
        totalBytes += bytes.length;
        return [
          {
            mediaType: prepared.mediaType,
            dataBase64: bytes.toString("base64"),
            path: prepared.path,
          },
        ];
      } catch {
        return [];
      }
    });
    const { images: _images, ...rest } = message;
    return images.length > 0 ? { ...rest, images } : rest;
  });
}

/**
 * Settled transcript items are immutable, so their scrubbed projection can be
 * reused across autosaves instead of re-redacting the whole transcript.
 */
const scrubbedItems = new WeakMap<TranscriptItem, TranscriptItem>();

function isSettledItem(item: TranscriptItem): boolean {
  if (item.done !== true) return false;
  if (item.kind === "assistant") return item.streaming !== true;
  if (item.kind === "tool") return item.status !== "running";
  return true;
}

function scrubTranscript(items?: TranscriptItem[] | undefined): TranscriptItem[] | undefined {
  if (!items) return undefined;
  // Drop UI chrome notices — they must never bloat saved history item counts.
  const durable = items.filter((item) => item.kind !== "notice");
  return durable.map((item) => {
    const reusable = isSettledItem(item);
    if (reusable) {
      const cached = scrubbedItems.get(item);
      if (cached) return cached;
    }
    const scrubbed = scrubTranscriptItem(item);
    if (reusable) scrubbedItems.set(item, scrubbed);
    return scrubbed;
  });
}

function scrubTranscriptItem(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case "user":
      return { ...item, text: redactSecretsCached(item.text), done: true };
    case "assistant":
      return { ...item, text: redactSecretsCached(item.text), streaming: false, done: true };
    case "thinking":
      return { ...item, content: redactSecretsCached(item.content), done: true };
    case "tool":
      return {
        ...item,
        argsDisplay: redactSecretsCached(item.argsDisplay),
        output: redactSecretsCached(item.output),
        summary: item.summary ? redactSecretsCached(item.summary) : item.summary,
        status: item.status === "running" ? "ok" : item.status,
        done: true,
      };
    case "plan":
      return { ...item, done: true };
    case "compacted":
      return {
        ...item,
        summary: redactSecretsCached(item.summary),
        originalItems: scrubTranscript(item.originalItems) ?? [],
        done: true,
      };
    default: {
      // notice already filtered; keep exhaustiveness for future kinds
      return item;
    }
  }
}

const JSONL_LOCK_STALE_MS = 60_000;
const JSONL_LOCK_RETRIES = 200;

/** Serialize stale-lock reclamation and recheck the owner while holding it. */
async function reapStaleJsonlLock(): Promise<void> {
  let reaper: Awaited<ReturnType<typeof open>>;
  const reaperToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    reaper = await open(jsonlLockReaperPath(), "wx", 0o600);
    try {
      await reaper.writeFile(reaperToken);
    } catch (error) {
      await reaper.close().catch(() => undefined);
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const existingToken = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    const reaperStat = await stat(jsonlLockReaperPath()).catch(() => undefined);
    if (
      !reaperStat ||
      Date.now() - reaperStat.mtimeMs <= JSONL_LOCK_STALE_MS
    ) {
      return;
    }
    const confirmed = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    if (confirmed !== undefined && confirmed === existingToken) {
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    const token = await readFile(jsonlLockFilePath(), "utf8").catch(
      () => undefined,
    );
    const lockStat = await stat(jsonlLockFilePath()).catch(() => undefined);
    if (!lockStat || Date.now() - lockStat.mtimeMs <= JSONL_LOCK_STALE_MS) {
      return;
    }
    // The live owner refreshes mtime periodically. A stale marker—including
    // an empty marker left between open/write—is therefore safe to reclaim.
    const confirmed = await readFile(jsonlLockFilePath(), "utf8").catch(
      () => undefined,
    );
    if (confirmed !== undefined && confirmed === token) {
      await rm(jsonlLockFilePath(), { force: true });
    }
  } finally {
    await reaper.close().catch(() => undefined);
    const currentReaper = await readFile(jsonlLockReaperPath(), "utf8").catch(
      () => undefined,
    );
    if (currentReaper === reaperToken) {
      await rm(jsonlLockReaperPath(), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Cross-process lock around JSONL read/modify/rename. Atomic rename protects
 * readers, but without this lock two clai processes can both read the same
 * base file and then each replace it, dropping whichever session they did not
 * observe. The lock is transient and stale crash leftovers self-heal.
 */
async function acquireJsonlWriteLock(): Promise<() => Promise<void>> {
  await mkdir(historyDirPath(), { recursive: true });
  for (let attempt = 0; attempt < JSONL_LOCK_RETRIES; attempt += 1) {
    try {
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handle = await open(jsonlLockFilePath(), "wx", 0o600);
      try {
        await handle.writeFile(token);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(jsonlLockFilePath(), { force: true }).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(jsonlLockFilePath(), now, now).catch(() => undefined);
      }, JSONL_LOCK_STALE_MS / 3);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await handle.close().catch(() => undefined);
        const currentToken = await readFile(jsonlLockFilePath(), "utf8").catch(
          () => undefined,
        );
        if (currentToken === token) {
          await rm(jsonlLockFilePath(), { force: true }).catch(() => undefined);
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await reapStaleJsonlLock();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("timed out waiting for history write lock");
}

/**
 * Serializes every JSONL mutation through a single promise chain so concurrent
 * autosaves never interleave a read with another writer's truncating write.
 * Without this, a reader could observe a half-written (or momentarily empty)
 * file and then persist back only its own record, wiping every other session.
 */
let jsonlWriteChain: Promise<void> = Promise.resolve();
/** Shared one-time orphan/archive recovery; writes await it, UI listings may not. */
let recoveryPromise: Promise<void> | undefined;

/** Queue a locked JSONL section; the chain survives individual failures. */
function queueJsonlWrite<T>(
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

function updatedAtMs(record: HistoryRecord): number {
  const t = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

function historyRevision(record: HistoryRecord | undefined): number {
  const revision = record?.revision;
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? revision
    : 0;
}

function historyWriterGeneration(
  record: HistoryRecord | undefined,
): string | undefined {
  const generation = record?.writerGeneration;
  return typeof generation === "string" && generation.length > 0
    ? generation
    : undefined;
}

/**
 * Compare snapshots by writer generation, then capture revision. Legacy rows
 * without a generation retain revision/timestamp fallback for compatibility.
 */
export function compareHistoryFreshness(
  left: HistoryRecord,
  right: HistoryRecord,
): number {
  const leftGeneration = historyWriterGeneration(left);
  const rightGeneration = historyWriterGeneration(right);
  if (leftGeneration || rightGeneration) {
    if (!leftGeneration) return -1;
    if (!rightGeneration) return 1;
    const generationDelta = leftGeneration.localeCompare(rightGeneration);
    if (generationDelta !== 0) return generationDelta;
  }

  const revisionDelta = historyRevision(left) - historyRevision(right);
  if (revisionDelta !== 0) return revisionDelta;
  if (historyRevision(left) > 0) return 0;
  return updatedAtMs(left) - updatedAtMs(right);
}

/** Keep the newest captured version of each session id. */
export function dedupeHistoryById(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  const byId = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!record?.id) continue;
    const prev = byId.get(record.id);
    // Preserve the first source on an exact tie. JSONL is passed first during
    // cross-backend merge and is the durable canonical copy.
    if (!prev || compareHistoryFreshness(record, prev) > 0) {
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

/** Session count without parsing the whole file when the index is valid. */
async function countJsonlSessions(): Promise<number> {
  const entries = await readValidatedHistoryIndex(
    jsonlFilePath(),
    jsonlIndexFilePath(),
  );
  if (entries) return entries.length;
  return (await readJsonlRecordsFrom(jsonlFilePath())).length;
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

// Restore backups only for a missing/corrupt active file, then merge orphan write temps.
export async function recoverOrphanedHistory(): Promise<{
  recovered: number;
  sources: string[];
}> {
  const sources: string[] = [];
  const tempSources: string[] = [];
  const releaseLock = await acquireJsonlWriteLock();
  try {
    const activePath = jsonlFilePath();
    const activeExists = await safeExists(activePath);
    let activeCorrupt = false;
    let active: HistoryRecord[] = [];
    if (activeExists) {
      try {
        const raw = await readFile(activePath, "utf8");
        const lines = raw.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          try {
            active.push(JSON.parse(line) as HistoryRecord);
          } catch {
            activeCorrupt = true;
          }
        }
      } catch (error: any) {
        if (error?.code === "EACCES") handlePermissionError(error);
        activeCorrupt = true;
      }
    }

    const backupRecords: HistoryRecord[] = [];
    if (!activeExists || activeCorrupt) {
      try {
        const backups = (await readdir(backupDirPath()))
          .filter((name) => name.startsWith("history-") && name.endsWith(".jsonl"))
          .sort()
          .reverse();
        for (const name of backups) {
          const rows = await readJsonlRecordsFrom(join(backupDirPath(), name));
          if (rows.length === 0) continue;
          backupRecords.push(...rows);
          sources.push(`history-backups/${name}`);
          break;
        }
      } catch {
        // No usable backup directory.
      }
    }

    const extras: HistoryRecord[] = [];
    try {
      const names = await readdir(historyDirPath());
      for (const name of names) {
        if (!name.startsWith("history.jsonl.") || !name.endsWith(".tmp")) {
          continue;
        }
        const path = join(historyDirPath(), name);
        const rows = await readJsonlRecordsFrom(path);
        if (rows.length === 0) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        extras.push(...rows);
        sources.push(name);
        tempSources.push(name);
      }
    } catch {
      // History directory may not exist yet.
    }

    const activeById = new Map(active.map((record) => [record.id, record]));
    const merged = dedupeHistoryById([...active, ...backupRecords, ...extras]);
    const recoveredCount = merged.filter((record) => {
      const previous = activeById.get(record.id);
      return !previous || compareHistoryFreshness(record, previous) > 0;
    }).length;
    const needsRewrite =
      activeCorrupt ||
      (!activeExists && backupRecords.length > 0) ||
      recoveredCount > 0;
    if (!needsRewrite) return { recovered: 0, sources };

    await mkdir(historyDirPath(), { recursive: true });
    await fixOwner(historyDirPath());
    if (activeExists && !activeCorrupt) await backupActiveHistory();
    const sorted = sortHistoryByUpdatedDesc(merged);
    sorted.reverse();
    await writeIndexedJsonl(activePath, jsonlIndexFilePath(), sorted);
    await Promise.all([
      fixOwner(activePath),
      fixOwner(jsonlIndexFilePath()),
    ]);

    for (const name of tempSources) {
      await rm(join(historyDirPath(), name), { force: true }).catch(() => undefined);
    }
    return { recovered: recoveredCount, sources };
  } finally {
    await releaseLock();
  }
}

function startHistoryRecovery(): Promise<void> {
  if (!recoveryPromise) {
    recoveryPromise = recoverOrphanedHistory()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        // A background recovery may have merged archive/temp records after a
        // picker list was published; force the next /history to refresh.
        invalidateSessionListCache();
      });
  }
  return recoveryPromise;
}

async function ensureHistoryRecovered(): Promise<void> {
  await startHistoryRecovery();
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

function serializeSessionPayload(record: HistoryRecord): string {
  return JSON.stringify({
    messages: record.messages,
    transcript: record.transcript,
    ...(record.contextUsage ? { contextUsage: record.contextUsage } : {}),
    ...(record.previousTurn ? { previousTurn: record.previousTurn } : {}),
    ...(record.workspaceFolder
      ? {
          workspaceFolder: record.workspaceFolder,
          workspaceCode: record.workspaceCode,
        }
      : {}),
  });
}

/** SQLite mirror write with atomic generation/revision rejection. */
function upsertSqlite(db: DatabaseLike, record: HistoryRecord): void {
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

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
  contextUsage?: PersistedContextUsage | undefined,
  revision?: number | undefined,
  writerGeneration?: string | undefined,
  previousTurn?: PreviousTurnSignal | null | undefined,
): Promise<HistoryRecord> {
  // Auto-derive a readable name from the first real user message if none provided
  if (!name) {
    const firstUser = messages.find(
      (m) => m.role === "user" && !isInternalChatMessage(m),
    );
    if (firstUser) {
      const preview = firstUser.content.slice(0, 60).replace(/\n/g, " ").trim();
      name = preview + (firstUser.content.length > 60 ? "…" : "");
    }
  }

  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive();
  const record: HistoryRecord = {
    id: newId(),
    ...(writerGeneration ? { writerGeneration } : {}),
    revision:
      typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
        ? revision
        : 1,
    name,
    createdAt: now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
    ...(contextUsage ? { contextUsage } : {}),
    ...(previousTurn ? { previousTurn } : {}),
    ...workspace,
  };

  // Private mode: never persist chat content. Caller still gets a record
  // back (so /save echoes a usable id) but nothing hits disk.
  if (getConfig().privateMode) return record;

  invalidateSessionListCache();
  const db = await loadDatabase();

  const canonical = await upsertJsonl(record);
  if (db) {
    upsertSqlite(db, canonical);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return canonical;
}

export async function upsertSession(
  id: string,
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
  contextUsage?: PersistedContextUsage | undefined,
  revision?: number | undefined,
  writerGeneration?: string | undefined,
  previousTurn?: PreviousTurnSignal | null | undefined,
): Promise<HistoryRecord> {
  const existing = await getSession(id);
  const requestedRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      ? revision
      : undefined;
  const firstUser = messages.find(
    (message) => message.role === "user" && !isInternalChatMessage(message),
  );
  const derivedName = firstUser
    ? firstUser.content.slice(0, 60).replace(/\n/g, " ").trim() +
      (firstUser.content.length > 60 ? "…" : "")
    : undefined;
  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive(existing);
  const effectiveWriterGeneration =
    writerGeneration ?? existing?.writerGeneration;
  const record: HistoryRecord = {
    id,
    ...(effectiveWriterGeneration
      ? { writerGeneration: effectiveWriterGeneration }
      : {}),
    revision:
      requestedRevision ??
      (writerGeneration ? 1 : historyRevision(existing) + 1),
    name: name ?? existing?.name ?? derivedName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    cwd: safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
    ...(contextUsage
      ? { contextUsage }
      : existing?.contextUsage
        ? { contextUsage: existing.contextUsage }
        : {}),
    ...(previousTurn
      ? { previousTurn }
      : previousTurn === undefined && existing?.previousTurn
        ? { previousTurn: existing.previousTurn }
        : {}),
    ...workspace,
  };

  if (
    existing &&
    requestedRevision !== undefined &&
    compareHistoryFreshness(record, existing) <= 0
  ) {
    return existing;
  }
  if (getConfig().privateMode) return record;

  invalidateSessionListCache();
  const db = await loadDatabase();
  const canonical = await upsertJsonl(record);
  if (db) {
    upsertSqlite(db, canonical);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return canonical;
}

async function enforceSqliteRetention(db: DatabaseLike): Promise<void> {
  const limit = getConfig().historyRetentionLimit;
  if (!limit || limit <= 0) return;
  // Archive rows about to be deleted, then delete — never hard-drop without
  // a JSONL archive copy.
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
    /* archive best-effort */
  }
  db.exec(
    `DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ${Math.floor(limit)});`,
  );
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
    if (stored) return stored;
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

async function upsertJsonl(record: HistoryRecord): Promise<HistoryRecord> {
  return queueJsonlWrite(
    () => upsertJsonlUnderLock(record),
    () => record,
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
  invalidateSessionListCache();
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
        workspaceFolder?: string;
        workspaceCode?: string;
      };
  const messages = Array.isArray(parsed) ? parsed : parsed.messages ?? [];
  return {
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
    transcript: Array.isArray(parsed) ? undefined : parsed.transcript,
    contextUsage: Array.isArray(parsed) ? undefined : parsed.contextUsage,
    previousTurn: Array.isArray(parsed) ? undefined : parsed.previousTurn,
    workspaceFolder: Array.isArray(parsed) ? undefined : parsed.workspaceFolder,
    workspaceCode: Array.isArray(parsed) ? undefined : parsed.workspaceCode,
  };
}

function rowToSummary(row: unknown): HistorySummary {
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
    cachedSessionList = {
      historyDir: cacheKey,
      summaries,
      cachedAt: Date.now(),
      coversAll,
    };
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
    if (indexed) return indexed;
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
    return active;
  }
  return findHistoryRecordStreaming<HistoryRecord>(
    archiveFilePath(),
    sessionId,
  );
}

export function getHistoryPath(): string {
  // Prefer JSONL as the durable path users can inspect/backup; SQLite is
  // optional acceleration when better-sqlite3 is installed.
  return jsonlFilePath();
}


export async function clearAllHistory(): Promise<{
  cleared: boolean;
  detail: string;
}> {
  await ensureHistoryRecovered();
  const details: string[] = [];

  try {
    invalidateSessionListCache();
    const db = await loadDatabase();
    if (db) {
      db.exec(
        "DELETE FROM sessions; DELETE FROM tool_calls; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;",
      );
      details.push("sqlite cleared");
    }
  } catch (error) {
    details.push(
      `sqlite error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const releaseLock = await acquireJsonlWriteLock();
  try {
    const names = await readdir(historyDirPath()).catch(() => [] as string[]);
    const removable = names.filter(
      (name) =>
        name === "history.jsonl" ||
        name === "history.index.json" ||
        name === "history-archive.jsonl" ||
        name === "history-backups" ||
        name.startsWith("history-cleared-") ||
        (name.startsWith("history.jsonl.") && name.endsWith(".tmp")),
    );
    await Promise.all(
      removable.map((name) =>
        rm(join(historyDirPath(), name), { recursive: true, force: true }),
      ),
    );
    details.push("history, index, archives, and backups deleted");
  } catch (error) {
    details.push(
      `history file error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await releaseLock();
  }

  try {
    const { clearAllPlans } = await import("./plan.js");
    await clearAllPlans();
    details.push("plans cleared");
  } catch {
    details.push("plan store unavailable");
  }
  invalidateSessionListCache();
  return { cleared: true, detail: details.join("; ") };
}

async function removeSessionFromHistoryFile(
  path: string,
  sessionId: string,
): Promise<boolean> {
  const records = await readJsonlRecordsFrom(path);
  const retained = records.filter((record) => record.id !== sessionId);
  if (retained.length === records.length) return false;
  if (retained.length === 0) {
    await rm(path, { force: true });
    return true;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
  await fixOwner(path);
  return true;
}

export async function deleteSession(sessionId: string): Promise<{ deleted: boolean; detail: string }> {
  const id = sessionId.trim();
  if (!id) return { deleted: false, detail: "missing session id" };
  await ensureHistoryRecovered();
  let deletedFromJsonl = false;
  let deletedFromArchive = false;
  let deletedFromBackup = false;
  let deletedFromSqlite = false;
  let historyWriteFailed = false;
  await queueJsonlWrite(async () => {
    const current = await readJsonlRecordsFrom(jsonlFilePath());
    const filtered = current.filter((r) => r.id !== id);
    deletedFromJsonl = filtered.length !== current.length;
    if (deletedFromJsonl) {
      await writeJsonlAtomic(filtered, current.length);
    }
    deletedFromArchive = await removeSessionFromHistoryFile(archiveFilePath(), id);
    const backupNames = (await readdir(backupDirPath()).catch(() => [] as string[]))
      .filter((name) => name.startsWith("history-") && name.endsWith(".jsonl"));
    for (const name of backupNames) {
      deletedFromBackup =
        (await removeSessionFromHistoryFile(join(backupDirPath(), name), id)) ||
        deletedFromBackup;
    }
  }, () => {
    historyWriteFailed = true;
  });
  if (historyWriteFailed) {
    return { deleted: false, detail: "could not remove the session from history files" };
  }
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(id);
      const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      const changes = (result as unknown as { changes: number }).changes ?? 0;
      if (changes > 0) deletedFromSqlite = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
      invalidateSessionListCache();
    }
  } catch (error) {
    return {
      deleted: false,
      detail: `could not remove the session from the history database: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  invalidateSessionListCache();
  if (!deletedFromJsonl && !deletedFromArchive && !deletedFromBackup && !deletedFromSqlite) {
    const existing = await getSession(id);
    if (existing) return { deleted: false, detail: "failed to delete" };
    return { deleted: false, detail: "session not found" };
  }
  return { deleted: true, detail: `deleted ${id}` };
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
