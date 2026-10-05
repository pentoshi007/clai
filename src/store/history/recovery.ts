import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { canonicalizeChatMessageReasoningArtifacts } from "../../llm/reasoning-artifacts.js";
import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import type { ChatMessage, ProviderId, ReasoningPreference } from "../../types.js";
import { historySummary, readValidatedHistoryIndex, rebuildHistoryIndexWithStatus, rewriteIndexedHistorySources, scanHistoryJsonl } from "../history-index.js";
import type { HistorySourceEntry, HistorySummary } from "../history-index.js";
import { acquireJsonlWriteLock, historyDirPath } from "./jsonl-lock.js";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export function jsonlFilePath(): string {
  return join(historyDirPath(), "history.jsonl");
}

export function jsonlIndexFilePath(): string {
  return join(historyDirPath(), "history.index.json");
}

export function backupDirPath(): string {
  return join(historyDirPath(), "history-backups");
}

const MAX_HISTORY_BACKUPS = 12;

export interface PersistedContextUsage {
  contextTokens: number;
  contextLimit?: number | undefined;
  lastCompletionTokens?: number | undefined;
  sessionPromptTokens?: number | undefined;
  sessionCompletionTokens?: number | undefined;
  exact: boolean;
  contextSnapshot?: import("../../llm/context-snapshot.js").ContextSnapshotV1 | undefined;
  routeUsage?:
    | readonly import("../../app/controllers/session-usage-ledger.js").PersistedRouteUsage[]
    | undefined;
}

export interface HistoryRecord {
  id: string;
  writerGeneration?: string | undefined;
  revision?: number | undefined;
  name?: string | undefined;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: ChatMessage[];
  transcript?: TranscriptItem[] | undefined;
  contextUsage?: PersistedContextUsage | undefined;
  previousTurn?: PreviousTurnSignal | undefined;
  workspaceFolder?: string | undefined;
  workspaceCode?: string | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  thinking?: ReasoningPreference | undefined;
}

export let cachedSessionList:
  | {
      historyDir: string;
      summaries: HistorySummary[];
      cachedAt: number;
      coversAll: boolean;
    }
  | undefined;

export let sessionListGeneration = 0;

export function invalidateSessionListCache(): void {
  sessionListGeneration += 1;
  cachedSessionList = undefined;
}

export function hydrateHistoryRecord(record: HistoryRecord): HistoryRecord {
  return {
    ...record,
    messages: record.messages.map(canonicalizeChatMessageReasoningArtifacts),
  };
}

let recoveryPromise: Promise<void> | undefined;

function updatedAtMs(record: Pick<HistoryRecord, "updatedAt" | "createdAt">): number {
  const t = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

export function historyRevision(record: Pick<HistoryRecord, "revision"> | undefined): number {
  const revision = record?.revision;
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? revision
    : 0;
}

export function historyWriterGeneration(
  record: Pick<HistoryRecord, "writerGeneration"> | undefined,
): string | undefined {
  const generation = record?.writerGeneration;
  return typeof generation === "string" && generation.length > 0
    ? generation
    : undefined;
}

type HistoryFreshness = Pick<HistoryRecord, "writerGeneration" | "revision" | "createdAt" | "updatedAt">;

export function compareHistoryFreshness(
  left: HistoryFreshness,
  right: HistoryFreshness,
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

export function dedupeHistoryById(
  records: readonly HistoryRecord[],
): HistoryRecord[] {
  const byId = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (!record?.id) continue;
    const prev = byId.get(record.id);
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

async function scanLatestHistoryRecords(path: string): Promise<{
  records: HistoryRecord[];
  malformed: boolean;
}> {
  const byId = new Map<string, HistoryRecord>();
  const scan = await scanHistoryJsonl<HistoryRecord>(path, (record) => {
    if (!record?.id) return;
    const previous = byId.get(record.id);
    if (!previous || compareHistoryFreshness(record, previous) > 0) {
      byId.set(record.id, hydrateHistoryRecord(record));
    }
  });
  return { records: [...byId.values()], malformed: scan.malformed };
}

export async function readJsonlRecordsFrom(path: string): Promise<HistoryRecord[]> {
  try {
    return (await scanLatestHistoryRecords(path)).records;
  } catch (err: any) {
    if (err && err.code === "EACCES") handlePermissionError(err);
    return [];
  }
}

export async function backupActiveHistory(): Promise<void> {
  if (!(await safeExists(jsonlFilePath()))) return;
  try {
    await mkdir(backupDirPath(), { recursive: true });
    await fixOwner(backupDirPath());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(backupDirPath(), `history-${stamp}.jsonl`);
    await copyFile(jsonlFilePath(), dest);
    await fixOwner(dest).catch(() => undefined);
    const names = (await readdir(backupDirPath()))
      .filter((n) => n.startsWith("history-") && n.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const old of names.slice(MAX_HISTORY_BACKUPS)) {
      await rm(join(backupDirPath(), old), { force: true }).catch(() => undefined);
    }
  } catch {
  }
}

async function scanRecoverySource(path: string): Promise<{
  entries: HistorySourceEntry[];
  malformed: boolean;
}> {
  const byId = new Map<string, HistorySourceEntry>();
  const scan = await scanHistoryJsonl<HistoryRecord>(path, (record, offset, length) => {
    if (!record?.id) return;
    const summary = historySummary(record);
    const previous = byId.get(record.id);
    if (previous && compareHistoryFreshness(summary, previous.entry.summary) <= 0) return;
    byId.set(record.id, { path, entry: { id: record.id, offset, length, summary } });
  });
  return { entries: [...byId.values()], malformed: scan.malformed };
}

function mergeRecoveryEntries(
  target: Map<string, HistorySourceEntry>,
  entries: readonly HistorySourceEntry[],
): void {
  for (const source of entries) {
    const previous = target.get(source.entry.id);
    if (!previous || compareHistoryFreshness(source.entry.summary, previous.entry.summary) > 0) {
      target.set(source.entry.id, source);
    }
  }
}

async function readRecoveryBackup(sources: string[]): Promise<HistorySourceEntry[]> {
  const names = await readdir(backupDirPath()).catch(() => [] as string[]);
  const backups = names.filter((name) => name.startsWith("history-") && name.endsWith(".jsonl")).sort().reverse();
  for (const name of backups) {
    const scan = await scanRecoverySource(join(backupDirPath(), name)).catch(() => undefined);
    if (!scan?.entries.length) continue;
    sources.push(`history-backups/${name}`);
    return scan.entries;
  }
  return [];
}

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
    const names = await readdir(historyDirPath()).catch(() => [] as string[]);
    const tempNames = names.filter((name) => name.startsWith("history.jsonl.") && name.endsWith(".tmp"));
    if (activeExists && tempNames.length === 0) {
      const indexed = await readValidatedHistoryIndex(activePath, jsonlIndexFilePath());
      if (indexed) return { recovered: 0, sources };
      const rebuilt = await rebuildHistoryIndexWithStatus<HistoryRecord>(activePath, jsonlIndexFilePath());
      if (!rebuilt.malformed) return { recovered: 0, sources };
    }
    const active = activeExists
      ? await scanRecoverySource(activePath)
      : { entries: [], malformed: false };
    const activeById = new Map(active.entries.map((source) => [source.entry.id, source]));
    const merged = new Map(activeById);
    if (!activeExists || active.malformed) mergeRecoveryEntries(merged, await readRecoveryBackup(sources));
    for (const name of tempNames) {
      const path = join(historyDirPath(), name);
      const scan = await scanRecoverySource(path).catch(() => undefined);
      if (!scan) continue;
      if (scan.entries.length === 0) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      mergeRecoveryEntries(merged, scan.entries);
      sources.push(name);
      tempSources.push(path);
    }
    const recoveredCount = [...merged.values()].filter((source) => {
      const previous = activeById.get(source.entry.id);
      return !previous || compareHistoryFreshness(source.entry.summary, previous.entry.summary) > 0;
    }).length;
    if (active.malformed || recoveredCount > 0) {
      await mkdir(historyDirPath(), { recursive: true });
      await fixOwner(historyDirPath());
      if (activeExists && !active.malformed) await backupActiveHistory();
      const sorted = [...merged.values()].sort((a, b) => updatedAtMs(b.entry.summary) - updatedAtMs(a.entry.summary)).reverse();
      await rewriteIndexedHistorySources(activePath, jsonlIndexFilePath(), sorted);
      await Promise.all([fixOwner(activePath), fixOwner(jsonlIndexFilePath())]);
    } else if (activeExists) {
      await rebuildHistoryIndexWithStatus<HistoryRecord>(activePath, jsonlIndexFilePath());
    }
    for (const path of tempSources) await rm(path, { force: true }).catch(() => undefined);
    return { recovered: recoveredCount, sources };
  } finally {
    await releaseLock();
  }
}

export function startHistoryRecovery(): Promise<void> {
  if (!recoveryPromise) {
    recoveryPromise = recoverOrphanedHistory()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        invalidateSessionListCache();
      });
  }
  return recoveryPromise;
}

export async function ensureHistoryRecovered(): Promise<void> {
  await startHistoryRecovery();
}

export function setCachedSessionList(value: | {
      historyDir: string;
      summaries: HistorySummary[];
      cachedAt: number;
      coversAll: boolean;
    }
  | undefined): void {
  cachedSessionList = value;
}
