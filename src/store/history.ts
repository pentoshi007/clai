import { stat } from "node:fs/promises";
import { isInternalChatMessage, type ChatImage, type ChatMessage, type ToolCall, type ToolResult } from "../types.js";
import {
  imageBudgetFor,
  type ImageBudget,
} from "../attachments/image-content.js";
import { loadImagePaths } from "../ui/mentions.js";
import type { TranscriptItem } from "../app/ports/transcript-item.js";
import { flattenTranscriptHistory } from "../ui-core/state/transcript-history.js";
import type { PreviousTurnSignal } from "../agent/continue-orient.js";
import { redactSecrets } from "../llm/provider.js";
import { canonicalizeChatMessageReasoningArtifacts } from "../llm/reasoning-artifacts.js";
import { redactResponsesReplay, restoreResponsesReplay } from "../llm/responses-replay.js";
import { redactSecretsCached } from "./redaction-cache.js";
import { knownSecretsRevision } from "../security/known-secrets.js";
import { getConfig } from "./config.js";
import { safeCwd } from "../os/cwd.js";
import { getActiveSessionWorkspace } from "./session-workspace.js";
import { readValidatedHistoryIndex } from "./history-index.js";
import { HistoryRecord, PersistedContextUsage, backupDirPath, compareHistoryFreshness, dedupeHistoryById, ensureHistoryRecovered, historyRevision, invalidateSessionListCache, jsonlFilePath, jsonlIndexFilePath, sortHistoryByUpdatedDesc } from "./history/recovery.js";
import { SessionModelSelection, archiveFilePath, enforceSqliteRetention, loadDatabase, sessionModelFields, upsertSqlite } from "./history/sqlite-backend.js";
import { getSession } from "./history/session-queries.js";
import { readSessionHead, sessionMergeProbe, upsertSessionRecord } from "./history/session-store.js";
import { sessionLogPath, sessionsDirPath } from "./history/session-paths.js";
export { clearAllHistory, deleteSession, purgeSession } from "./history/lifecycle.js";
export { listSessionSummaries, listSessions } from "./history/session-queries.js";
export { getSession };
export { partitionByRetention } from "./history/jsonl-backend.js";
export type { SessionModelSelection } from "./history/sqlite-backend.js";
export { recoverOrphanedHistory } from "./history/recovery.js";
export { compareHistoryFreshness, dedupeHistoryById, sortHistoryByUpdatedDesc };
export type { HistoryRecord, PersistedContextUsage } from "./history/recovery.js";

export type { HistorySummary } from "./history-index.js";

const FALLBACK_SESSION_NAME_LIMIT = 96;

export interface HistorySessionLocation {
  readonly cwd: string;
  readonly workspaceFolder?: string | undefined;
  readonly workspaceCode?: string | undefined;
}

function fallbackSessionName(messages: ChatMessage[]): string | undefined {
  const firstUser = messages.find(
    (message) => message.role === "user" && !isInternalChatMessage(message),
  );
  if (!firstUser) return undefined;
  const preview = firstUser.content
    .slice(0, FALLBACK_SESSION_NAME_LIMIT)
    .replace(/\n/g, " ")
    .trim();
  return preview + (firstUser.content.length > FALLBACK_SESSION_NAME_LIMIT ? "…" : "");
}

function workspaceFieldsFromActive(existing?: HistoryRecord, location?: HistorySessionLocation): {
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
} {
  if (existing?.workspaceFolder) {
    return {
      workspaceFolder: existing.workspaceFolder,
      workspaceCode: existing.workspaceCode,
    };
  }
  if (location) {
    return {
      ...(location.workspaceFolder ? { workspaceFolder: location.workspaceFolder } : {}),
      ...(location.workspaceCode ? { workspaceCode: location.workspaceCode } : {}),
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

function scrubArgument(value: unknown): unknown {
  if (typeof value === "string") return redactSecretsCached(value);
  if (Array.isArray(value)) return value.map(scrubArgument);
  if (value !== null && typeof value === "object") return scrubArguments(Object.fromEntries(Object.entries(value)));
  return value;
}

function scrubArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, scrubArgument(value)]));
}

interface ScrubbedMessage {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly scrubbed: ChatMessage;
}

const SCRUBBED_SESSION_LIMIT = 8;
const scrubbedSessions = new Map<string, readonly ScrubbedMessage[]>();
let scrubbedSessionsRevision = knownSecretsRevision();

function sameFields(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function scrubMessagesFor(sessionId: string, messages: ChatMessage[]): ChatMessage[] {
  if (scrubbedSessionsRevision !== knownSecretsRevision()) {
    scrubbedSessions.clear();
    scrubbedSessionsRevision = knownSecretsRevision();
  }
  const previous = scrubbedSessions.get(sessionId) ?? [];
  const next = messages.map((source, index): ScrubbedMessage => {
    const fields = source as unknown as Readonly<Record<string, unknown>>;
    const known = previous[index];
    if (known && sameFields(known.fields, fields)) return known;
    return { fields: { ...fields }, scrubbed: scrubMessage(source) };
  });
  scrubbedSessions.delete(sessionId);
  scrubbedSessions.set(sessionId, next);
  if (scrubbedSessions.size > SCRUBBED_SESSION_LIMIT) scrubbedSessions.delete(scrubbedSessions.keys().next().value!);
  return next.map((entry) => entry.scrubbed);
}

function scrubMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(scrubMessage);
}

function scrubMessage(source: ChatMessage): ChatMessage {
  const message = restoreResponsesReplay(source);
  const { images, ...rest } = message;
  const persistedImages = images?.flatMap((image): ChatImage[] =>
    image.path
      ? [{ mediaType: image.mediaType, dataBase64: "", path: image.path }]
      : [],
  );
  return canonicalizeChatMessageReasoningArtifacts({
    ...rest,
    content: redactSecretsCached(message.content),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({
      ...call,
      args: scrubArguments(call.args),
      ...(call.rawArguments ? { rawArguments: redactSecretsCached(call.rawArguments) } : {}),
    })) } : {}),
    ...(message.responsesReplay ? {
      responsesReplay: redactResponsesReplay(message.responsesReplay, redactSecretsCached),
    } : {}),
    ...(persistedImages?.length ? { images: persistedImages } : {}),
  });
}

const MAX_RESTORED_IMAGE_COUNT = 6;

export async function materializeHistoryImages(
  messages: readonly ChatMessage[],
  budget: ImageBudget = imageBudgetFor(""),
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  let imageCount = 0;
  let totalBytes = 0;
  const maxCount = Math.min(MAX_RESTORED_IMAGE_COUNT, budget.maxCount);
  const output: ChatMessage[] = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    if (!message.images?.length) {
      output.push({ ...message });
      continue;
    }
    const images: ChatImage[] = [];
    for (const image of message.images) {
      if (imageCount >= maxCount || totalBytes >= budget.maxTotalBytes) break;
      const remaining = { ...budget, maxCount: 1, maxTotalBytes: budget.maxTotalBytes - totalBytes };
      const loaded = image.dataBase64 ? [image]
        : image.path ? await loadImagePaths([image.path], remaining, undefined, signal) : [];
      const candidate = loaded[0];
      if (!candidate) continue;
      const bytes = Buffer.byteLength(candidate.dataBase64, "base64");
      if (bytes > budget.hardMaxBytes || totalBytes + bytes > budget.maxTotalBytes) continue;
      imageCount += 1;
      totalBytes += bytes;
      images.push(candidate);
    }
    const { images: _images, ...rest } = message;
    output.push(images.length > 0 ? { ...rest, images } : rest);
  }
  return output;
}

let scrubbedItems = new WeakMap<TranscriptItem, TranscriptItem>();
let scrubbedRevision = knownSecretsRevision();

function isSettledItem(item: TranscriptItem): boolean {
  if (item.done !== true) return false;
  if (item.kind === "assistant") return item.streaming !== true;
  if (item.kind === "tool") return item.status !== "running";
  return true;
}

function scrubTranscript(items?: TranscriptItem[] | undefined): TranscriptItem[] | undefined {
  if (!items) return undefined;
  if (scrubbedRevision !== knownSecretsRevision()) {
    scrubbedItems = new WeakMap();
    scrubbedRevision = knownSecretsRevision();
  }
  const durable = flattenTranscriptHistory(items).filter((item) => item.kind !== "notice");
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
        originalItems: [],
        done: true,
      };
    default: {
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
  location?: HistorySessionLocation | undefined,
  changes?: readonly import("../app/controllers/session-changes.js").FileLineChanges[] | undefined,
): Promise<HistoryRecord> {
  if (!name) name = fallbackSessionName(messages);

  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive(undefined, location);
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
    cwd: location?.cwd ?? safeCwd(),
    messages: scrubMessages(messages),
    transcript: scrubTranscript(transcript),
    ...(changes ? { changes } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(previousTurn ? { previousTurn } : {}),
    ...sessionModelFields(sessionModel),
    ...workspace,
  };

  if (getConfig().privateMode) return record;

  return await persistRecord(record);
}

async function persistRecord(record: HistoryRecord): Promise<HistoryRecord> {
  invalidateSessionListCache();
  const db = await loadDatabase();
  await ensureHistoryRecovered();
  const canonical = await upsertSessionRecord(record);
  invalidateSessionListCache();
  if (db) {
    upsertSqlite(db, canonical);
    await enforceSqliteRetention(db);
    invalidateSessionListCache();
  }
  return canonical;
}

async function existingSessionHeader(id: string): Promise<HistoryRecord | undefined> {
  const head = await readSessionHead(id);
  if (head) return { ...head, messages: [] };
  return getSession(id);
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
  location?: HistorySessionLocation | undefined,
  changes?: readonly import("../app/controllers/session-changes.js").FileLineChanges[] | undefined,
  unsyncedItemIds?: readonly string[] | undefined,
): Promise<HistoryRecord> {
  const existing = await existingSessionHeader(id);
  const requestedRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      ? revision
      : undefined;
  const derivedName = fallbackSessionName(messages);
  const now = new Date().toISOString();
  const workspace = workspaceFieldsFromActive(existing, location);
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
    cwd: location?.cwd ?? safeCwd(),
    messages: scrubMessagesFor(id, messages),
    transcript: scrubTranscript(transcript),
    ...(changes ? { changes } : existing?.changes ? { changes: existing.changes } : {}),
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
    ...(unsyncedItemIds?.length ? { unsyncedItemIds: [...unsyncedItemIds] } : {}),
  };

  if (getConfig().privateMode) return record;
  return await persistRecord(record);
}

const mergeProbes = new Map<string, string>();

export async function pendingSessionMerge(id: string): Promise<HistoryRecord | undefined> {
  if (getConfig().privateMode) return undefined;
  const probe = await sessionMergeProbe(id);
  if (probe !== "absent") {
    if (probe === "unchanged" || probe.pendingMerge !== true) return undefined;
    const record = await getSession(id);
    return record?.pendingMerge === true ? record : undefined;
  }
  const info = await stat(jsonlFilePath()).catch(() => undefined);
  if (!info) return undefined;
  const stamp = `${info.size}:${info.mtimeMs}`;
  if (mergeProbes.get(id) === stamp) return undefined;
  mergeProbes.set(id, stamp);
  const entries = await readValidatedHistoryIndex(jsonlFilePath(), jsonlIndexFilePath());
  if (entries?.find((entry) => entry.id === id)?.summary.pendingMerge !== true) return undefined;
  return getSession(id);
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

export function getSessionsDir(): string {
  return sessionsDirPath();
}

export function getSessionLogPath(sessionId: string): string {
  return sessionLogPath(sessionId);
}
