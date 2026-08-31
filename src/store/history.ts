import { readFileSync } from "node:fs";
import { isInternalChatMessage, type ChatImage, type ChatMessage, type ToolCall, type ToolResult } from "../types.js";
import {
  imageBudgetFor,
  type ImageBudget,
} from "../attachments/image-content.js";
import { prepareImageForModel } from "../attachments/image-prepare.js";
import type { TranscriptItem } from "../app/ports/transcript-item.js";
import type { PreviousTurnSignal } from "../agent/continue-orient.js";
import { redactSecrets } from "../llm/provider.js";
import { canonicalizeChatMessageReasoningArtifacts } from "../llm/reasoning-artifacts.js";
import { redactSecretsCached } from "./redaction-cache.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { getActiveSessionWorkspace } from "./session-workspace.js";
import { type HistorySummary } from "./history-index.js";
import { HistoryRecord, PersistedContextUsage, backupDirPath, compareHistoryFreshness, dedupeHistoryById, historyRevision, invalidateSessionListCache, jsonlFilePath, sortHistoryByUpdatedDesc } from "./history/recovery.js";
import { SessionModelSelection, archiveFilePath, enforceSqliteRetention, loadDatabase, sessionModelFields, upsertSqlite } from "./history/sqlite-backend.js";
import { upsertJsonl } from "./history/jsonl-backend.js";
import { getSession } from "./history/session-queries.js";
export { clearAllHistory, deleteSession, purgeSession } from "./history/lifecycle.js";
export { listSessionSummaries, listSessions } from "./history/session-queries.js";
export { getSession };
export { partitionByRetention } from "./history/jsonl-backend.js";
export type { SessionModelSelection } from "./history/sqlite-backend.js";
export { recoverOrphanedHistory } from "./history/recovery.js";
export { compareHistoryFreshness, dedupeHistoryById, sortHistoryByUpdatedDesc };
export type { HistoryRecord, PersistedContextUsage } from "./history/recovery.js";

export type { HistorySummary } from "./history-index.js";

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
    return canonicalizeChatMessageReasoningArtifacts({
      ...rest,
      content: redactSecretsCached(message.content),
      ...(persistedImages?.length ? { images: persistedImages } : {}),
    });
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
        ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
        ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
        ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
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

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
  transcript?: TranscriptItem[] | undefined,
  contextUsage?: PersistedContextUsage | undefined,
  revision?: number | undefined,
  writerGeneration?: string | undefined,
  previousTurn?: PreviousTurnSignal | null | undefined,
  sessionModel?: SessionModelSelection | undefined,
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
    ...sessionModelFields(sessionModel),
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
  sessionModel?: SessionModelSelection | undefined,
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
    ...sessionModelFields(sessionModel, existing),
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

export function getHistoryPath(): string {
  // Prefer JSONL as the durable path users can inspect/backup; SQLite is
  // optional acceleration when better-sqlite3 is installed.
  return jsonlFilePath();
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
