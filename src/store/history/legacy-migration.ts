import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fixOwner } from "../../os/permissions.js";
import { getConfig } from "../config.js";
import {
  findHistoryRecordStreaming,
  readIndexedHistoryRecord,
  readValidatedHistoryIndex,
  rebuildHistoryIndex,
  type HistorySummary,
} from "../history-index.js";
import { acquireJsonlWriteLock } from "./jsonl-lock.js";
import { jsonlFilePath, jsonlIndexFilePath, type HistoryRecord } from "./recovery.js";
import { replaceFile } from "./session-log.js";
import { migrationMarkerPath, sessionsDirPath } from "./session-paths.js";
import { importSessionRecord } from "./session-store.js";

const MARKER_VERSION = 1;

interface LegacyStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

interface MigrationMarker {
  readonly version: typeof MARKER_VERSION;
  readonly legacy: LegacyStamp | null;
  readonly imported: Record<string, string>;
  readonly migratedAt: string;
}

let knownMarker: MigrationMarker | undefined;

async function legacyStamp(): Promise<LegacyStamp | null> {
  const info = await stat(jsonlFilePath()).catch(() => undefined);
  return info ? { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino } : null;
}

function sameLegacy(left: LegacyStamp | null | undefined, right: LegacyStamp | null): boolean {
  if (left === undefined) return false;
  if (left === null || right === null) return left === right;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

function fingerprint(summary: HistorySummary): string {
  return [
    summary.writerGeneration ?? "",
    summary.revision ?? "",
    summary.updatedAt,
    summary.itemCount,
    summary.messageCount,
    summary.pendingMerge === true ? "merge" : "",
  ].join("\u0000");
}

async function readMarker(): Promise<MigrationMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(migrationMarkerPath(), "utf8")) as Partial<MigrationMarker>;
    if (parsed.version !== MARKER_VERSION || !parsed.imported || typeof parsed.imported !== "object") return undefined;
    return parsed as MigrationMarker;
  } catch {
    return undefined;
  }
}

async function writeMarker(marker: MigrationMarker): Promise<void> {
  await mkdir(sessionsDirPath(), { recursive: true, mode: 0o700 });
  await fixOwner(sessionsDirPath());
  const path = migrationMarkerPath();
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
    await fixOwner(temporary);
    await replaceFile(temporary, path);
    knownMarker = marker;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function legacyRecord(entry: { id: string; offset: number; length: number; summary: HistorySummary }): Promise<HistoryRecord | undefined> {
  return await readIndexedHistoryRecord<HistoryRecord>(jsonlFilePath(), entry) ??
    await findHistoryRecordStreaming<HistoryRecord>(jsonlFilePath(), entry.id);
}

export async function migrateUnderLegacyLock(): Promise<void> {
  if (getConfig().privateMode) return;
  const stamp = await legacyStamp();
  const marker = await readMarker();
  if (marker && sameLegacy(marker.legacy, stamp)) {
    knownMarker = marker;
    return;
  }
  const imported: Record<string, string> = { ...(marker?.imported ?? {}) };
  if (stamp) {
    const entries = await readValidatedHistoryIndex(jsonlFilePath(), jsonlIndexFilePath()) ??
      await rebuildHistoryIndex<HistoryRecord>(jsonlFilePath(), jsonlIndexFilePath());
    for (const entry of entries) {
      const print = fingerprint(entry.summary);
      if (imported[entry.id] === print) continue;
      const record = await legacyRecord(entry);
      if (!record) continue;
      await importSessionRecord(record);
      imported[entry.id] = print;
    }
  }
  await writeMarker({
    version: MARKER_VERSION,
    legacy: await legacyStamp(),
    imported,
    migratedAt: new Date().toISOString(),
  });
}

export async function migrateLegacyHistory(): Promise<void> {
  if (getConfig().privateMode) return;
  const release = await acquireJsonlWriteLock();
  try {
    await migrateUnderLegacyLock();
  } finally {
    await release();
  }
}

export async function legacyHistoryMigrated(): Promise<boolean> {
  const marker = knownMarker ?? await readMarker();
  if (!marker) return (await legacyStamp()) === null;
  knownMarker = marker;
  return sameLegacy(marker.legacy, await legacyStamp());
}

export async function syncLegacyHistoryIfChanged(): Promise<void> {
  if (await legacyHistoryMigrated()) return;
  await migrateLegacyHistory();
}

export async function refreshMigrationMarkerUnderLegacyLock(): Promise<void> {
  const marker = await readMarker();
  if (!marker) return;
  await writeMarker({ ...marker, legacy: await legacyStamp() });
}

export function forgetMigrationMarker(): void {
  knownMarker = undefined;
}
