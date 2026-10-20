import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fixOwner } from "../../os/permissions.js";
import type { HistorySummary } from "../history-index.js";
import { acquireStorageWriteLock } from "./jsonl-lock.js";
import { loadSessionLog, loadSessionLogForKey, readSessionTailSummary, replaceFile, readTailSummaryForKey, statSessionLog, type LogStamp } from "./session-log.js";
import { isSessionKey, sessionIndexLockPath, sessionIndexPath, sessionKey, sessionsDirPath } from "./session-paths.js";

const INDEX_SCHEMA_VERSION = 1;
const STAMP_TOLERANCE_MS = 1;

export interface SessionIndexEntry {
  readonly key: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly summary: HistorySummary;
}

interface SessionIndexFile {
  readonly schemaVersion: typeof INDEX_SCHEMA_VERSION;
  readonly entries: Record<string, SessionIndexEntry>;
}

export type SessionIndexPatch = ReadonlyMap<string, SessionIndexEntry | undefined>;

export function indexEntryFor(sessionId: string, stamp: LogStamp, summary: HistorySummary): SessionIndexEntry {
  return { key: sessionKey(sessionId), size: stamp.size, mtimeMs: stamp.mtimeMs, summary };
}

function validEntry(id: string, entry: unknown): entry is SessionIndexEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<SessionIndexEntry>;
  return typeof candidate.key === "string" &&
    Number.isSafeInteger(candidate.size) &&
    typeof candidate.mtimeMs === "number" &&
    candidate.summary?.id === id;
}

export async function readSessionIndex(): Promise<Map<string, SessionIndexEntry> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionIndexPath(), "utf8")) as Partial<SessionIndexFile>;
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== "object") return undefined;
    const entries = new Map<string, SessionIndexEntry>();
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (validEntry(id, entry)) entries.set(id, entry);
    }
    return entries;
  } catch {
    return undefined;
  }
}

async function writeSessionIndex(entries: ReadonlyMap<string, SessionIndexEntry>): Promise<void> {
  await mkdir(sessionsDirPath(), { recursive: true, mode: 0o700 });
  await fixOwner(sessionsDirPath());
  const body: SessionIndexFile = { schemaVersion: INDEX_SCHEMA_VERSION, entries: Object.fromEntries(entries) };
  const path = sessionIndexPath();
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
    await fixOwner(temporary);
    await replaceFile(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function patchSessionIndex(patch: SessionIndexPatch): Promise<void> {
  if (patch.size === 0) return;
  const release = await acquireStorageWriteLock(sessionIndexLockPath(), "session index");
  try {
    const entries = (await readSessionIndex()) ?? await scanSessionSummaries();
    for (const [id, entry] of patch) {
      if (entry) entries.set(id, entry);
      else entries.delete(id);
    }
    await writeSessionIndex(entries);
  } finally {
    await release();
  }
}

async function sessionKeysOnDisk(): Promise<Set<string>> {
  const names = await readdir(sessionsDirPath(), { withFileTypes: true }).catch(() => []);
  return new Set(names.filter((entry) => entry.isDirectory() && isSessionKey(entry.name)).map((entry) => entry.name));
}

async function entryForKey(key: string): Promise<SessionIndexEntry | undefined> {
  const tail = await readTailSummaryForKey(key);
  if (tail) return indexEntryFor(tail.summary.id, tail.stamp, tail.summary);
  const loaded = await loadSessionLogForKey(key).catch(() => undefined);
  return loaded ? indexEntryFor(loaded.replayed.summary.id, loaded.stamp, loaded.replayed.summary) : undefined;
}

async function entryForSession(sessionId: string): Promise<SessionIndexEntry | undefined> {
  const tail = await readSessionTailSummary(sessionId);
  if (tail) return indexEntryFor(sessionId, tail.stamp, tail.summary);
  const loaded = await loadSessionLog(sessionId).catch(() => undefined);
  return loaded ? indexEntryFor(sessionId, loaded.stamp, loaded.replayed.summary) : undefined;
}

async function scanSessionSummaries(): Promise<Map<string, SessionIndexEntry>> {
  const entries = new Map<string, SessionIndexEntry>();
  const found = await Promise.all([...await sessionKeysOnDisk()].map(entryForKey));
  for (const entry of found) if (entry) entries.set(entry.summary.id, entry);
  return entries;
}

function stampMatches(entry: SessionIndexEntry, stamp: LogStamp | undefined): boolean {
  return stamp !== undefined && stamp.size === entry.size && Math.abs(stamp.mtimeMs - entry.mtimeMs) <= STAMP_TOLERANCE_MS;
}

export async function listIndexedSessions(): Promise<Map<string, SessionIndexEntry>> {
  const [indexed, keys] = await Promise.all([readSessionIndex(), sessionKeysOnDisk()]);
  const entries = indexed ?? new Map<string, SessionIndexEntry>();
  const patch = new Map<string, SessionIndexEntry | undefined>();
  const seenKeys = new Set<string>();
  await Promise.all([...entries].map(async ([id, entry]) => {
    if (!keys.has(entry.key)) {
      entries.delete(id);
      patch.set(id, undefined);
      return;
    }
    seenKeys.add(entry.key);
    const stamp = await statSessionLog(id);
    if (stampMatches(entry, stamp)) return;
    const refreshed = await entryForSession(id);
    if (!refreshed) {
      entries.delete(id);
      patch.set(id, undefined);
      return;
    }
    entries.set(id, refreshed);
    patch.set(id, refreshed);
  }));
  const unindexed = [...keys].filter((key) => !seenKeys.has(key));
  const discovered = await Promise.all(unindexed.map(entryForKey));
  for (const entry of discovered) {
    if (!entry) continue;
    entries.set(entry.summary.id, entry);
    patch.set(entry.summary.id, entry);
  }
  if (patch.size > 0) await patchSessionIndex(patch).catch(() => undefined);
  return entries;
}
