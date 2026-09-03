import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { canonicalizeChatMessageReasoningArtifacts } from "../../llm/reasoning-artifacts.js";
import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import type { ChatMessage, ProviderId, ReasoningPreference } from "../../types.js";
import { readValidatedHistoryIndex, rebuildHistoryIndexWithStatus, writeIndexedJsonl } from "../history-index.js";
import type { HistorySummary } from "../history-index.js";
import { acquireJsonlWriteLock, historyDirPath } from "./jsonl-lock.js";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
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

function updatedAtMs(record: HistoryRecord): number {
  const t = Date.parse(record.updatedAt || record.createdAt || "");
  return Number.isFinite(t) ? t : 0;
}

export function historyRevision(record: HistoryRecord | undefined): number {
  const revision = record?.revision;
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? revision
    : 0;
}

export function historyWriterGeneration(
  record: HistoryRecord | undefined,
): string | undefined {
  const generation = record?.writerGeneration;
  return typeof generation === "string" && generation.length > 0
    ? generation
    : undefined;
}

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

export async function readJsonlRecordsFrom(path: string): Promise<HistoryRecord[]> {
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
      .filter((record): record is HistoryRecord => record !== null)
      .map(hydrateHistoryRecord);
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
    const tempNames = await readdir(historyDirPath())
      .then((names) =>
        names.filter(
          (name) =>
            name.startsWith("history.jsonl.") && name.endsWith(".tmp"),
        ),
      )
      .catch(() => [] as string[]);
    if (activeExists && tempNames.length === 0) {
      const indexed = await readValidatedHistoryIndex(
        activePath,
        jsonlIndexFilePath(),
      );
      if (indexed) return { recovered: 0, sources };
      const rebuilt = await rebuildHistoryIndexWithStatus<HistoryRecord>(
        activePath,
        jsonlIndexFilePath(),
      );
      if (!rebuilt.malformed) return { recovered: 0, sources };
    }
    let activeCorrupt = false;
    let active: HistoryRecord[] = [];
    if (activeExists) {
      try {
        const raw = await readFile(activePath, "utf8");
        const lines = raw.split("\n").filter((line) => line.trim().length > 0);
        for (const line of lines) {
          try {
            active.push(
              hydrateHistoryRecord(JSON.parse(line) as HistoryRecord),
            );
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
