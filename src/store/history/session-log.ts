import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fixOwner } from "../../os/permissions.js";
import type { HistorySummary } from "../history-index.js";
import { SessionReplay, stateFromReplay, type ReplayedSession, type SessionLogState } from "./session-frames.js";
import { SESSION_LOG_NAME, sessionDirPath, sessionKey, sessionLogPath, sessionLogPathForKey, sessionsDirPath } from "./session-paths.js";

const STATE_CACHE_LIMIT = 8;
const TAIL_CHUNK_BYTES = 64 * 1024;
const RENAME_ATTEMPTS = 8;

export interface LogStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export interface LoadedSessionLog {
  readonly replayed: ReplayedSession;
  readonly stamp: LogStamp;
  readonly validEnd: number;
  readonly path: string;
}

interface CachedState {
  readonly stamp: LogStamp;
  readonly state: SessionLogState;
}

const stateCache = new Map<string, CachedState>();

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

export function stampOf(info: { size: number; mtimeMs: number; ino: number }): LogStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

export function sameStamp(left: LogStamp | undefined, right: LogStamp | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.size === right.size && left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

export function stampKey(stamp: LogStamp): string {
  return `${stamp.size}:${stamp.mtimeMs}:${stamp.ino}`;
}

export async function statSessionLog(sessionId: string): Promise<LogStamp | undefined> {
  const info = await stat(sessionLogPath(sessionId)).catch(() => undefined);
  return info ? stampOf(info) : undefined;
}

export function cachedSessionState(sessionId: string, stamp: LogStamp | undefined): SessionLogState | undefined {
  const cached = stateCache.get(sessionId);
  if (!cached || !sameStamp(cached.stamp, stamp)) return undefined;
  stateCache.delete(sessionId);
  stateCache.set(sessionId, cached);
  return cached.state;
}

export function rememberSessionState(sessionId: string, stamp: LogStamp, state: SessionLogState): void {
  stateCache.delete(sessionId);
  stateCache.set(sessionId, { stamp, state });
  while (stateCache.size > STATE_CACHE_LIMIT) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

export function forgetSessionState(sessionId?: string): void {
  if (sessionId === undefined) stateCache.clear();
  else stateCache.delete(sessionId);
}

function replayBuffer(sessionId: string, buffer: Buffer): { replayed: ReplayedSession | undefined; validEnd: number } {
  const replay = new SessionReplay(sessionId);
  let start = 0;
  let validEnd = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline < 0) break;
    const bytes = newline + 1 - start;
    if (newline > start && !replay.accept(buffer.toString("utf8", start, newline), bytes)) break;
    start = newline + 1;
    validEnd = start;
  }
  return { replayed: replay.result(), validEnd };
}

async function readLogFile(sessionId: string, path: string): Promise<LoadedSessionLog | undefined> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const { replayed, validEnd } = replayBuffer(sessionId, buffer.subarray(0, offset));
    if (!replayed) return undefined;
    return { replayed, stamp: stampOf(info), validEnd, path };
  } finally {
    await handle.close();
  }
}

async function orphanedRewrites(sessionId: string): Promise<string[]> {
  const dir = sessionDirPath(sessionId);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.startsWith(`${SESSION_LOG_NAME}.`) && name.endsWith(".tmp"))
    .map((name) => join(dir, name));
}

async function readOrphanedRewrite(sessionId: string): Promise<LoadedSessionLog | undefined> {
  let best: LoadedSessionLog | undefined;
  for (const path of await orphanedRewrites(sessionId)) {
    const loaded = await readLogFile(sessionId, path).catch(() => undefined);
    if (loaded && (!best || loaded.replayed.seq > best.replayed.seq)) best = loaded;
  }
  return best;
}

function firstFrameSessionId(buffer: Buffer): string | undefined {
  const newline = buffer.indexOf(0x0a);
  const prefix = buffer.toString("utf8", 0, Math.min(newline < 0 ? buffer.length : newline, TAIL_CHUNK_BYTES));
  return summaryFromFramePrefix(prefix, () => true)?.id;
}

export async function loadSessionLogForKey(key: string): Promise<LoadedSessionLog | undefined> {
  const path = sessionLogPathForKey(key);
  const buffer = await readFile(path).catch(() => undefined);
  if (!buffer) return undefined;
  const id = firstFrameSessionId(buffer);
  if (!id || sessionKey(id) !== key) return undefined;
  return await loadSessionLog(id);
}

export async function loadSessionLog(sessionId: string): Promise<LoadedSessionLog | undefined> {
  const path = sessionLogPath(sessionId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readLogFile(sessionId, path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return await readOrphanedRewrite(sessionId);
}

export async function loadSessionStateForWrite(sessionId: string): Promise<{
  state: SessionLogState | undefined;
  stamp: LogStamp | undefined;
  loaded?: LoadedSessionLog | undefined;
}> {
  await settleOrphanedRewrites(sessionId);
  const stamp = await statSessionLog(sessionId);
  if (!stamp) return { state: undefined, stamp: undefined };
  const cached = cachedSessionState(sessionId, stamp);
  if (cached) return { state: cached, stamp };
  const loaded = await loadSessionLog(sessionId);
  if (!loaded) {
    await quarantineUnreadableLog(sessionId);
    return { state: undefined, stamp: undefined };
  }
  if (loaded.validEnd < loaded.stamp.size) {
    await preserveRejectedFrames(loaded.path, loaded.validEnd, loaded.stamp.size);
    await truncate(loaded.path, loaded.validEnd);
    const repaired = await statSessionLog(sessionId);
    if (!repaired) return { state: undefined, stamp: undefined };
    const state = stateFromReplay(loaded.replayed);
    rememberSessionState(sessionId, repaired, state);
    return { state, stamp: repaired, loaded: { ...loaded, stamp: repaired } };
  }
  const state = stateFromReplay(loaded.replayed);
  rememberSessionState(sessionId, loaded.stamp, state);
  return { state, stamp: loaded.stamp, loaded };
}

async function preserveRejectedFrames(path: string, from: number, size: number): Promise<void> {
  const tail = Buffer.allocUnsafe(size - from);
  const source = await open(path, "r");
  try {
    let offset = 0;
    while (offset < tail.length) {
      const { bytesRead } = await source.read(tail, offset, tail.length - offset, from + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    await source.close();
  }
  if (!tail.includes(0x0a)) return;
  const kept = `${path}.rejected-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const handle = await open(kept, "wx", 0o600);
  try {
    await writeAll(handle, tail, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fixOwner(kept);
}

async function quarantineUnreadableLog(sessionId: string): Promise<void> {
  const path = sessionLogPath(sessionId);
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  if (info.size === 0) {
    await rm(path, { force: true });
    return;
  }
  await replaceFile(path, `${path}.unreadable-${Date.now()}`);
}

async function settleOrphanedRewrites(sessionId: string): Promise<void> {
  const orphans = await orphanedRewrites(sessionId);
  if (orphans.length === 0) return;
  const path = sessionLogPath(sessionId);
  const active = await readLogFile(sessionId, path).catch(() => undefined);
  if (!active) {
    const rescued = await readOrphanedRewrite(sessionId);
    if (rescued) await replaceFile(rescued.path, path);
  }
  for (const orphan of await orphanedRewrites(sessionId)) await rm(orphan, { force: true }).catch(() => undefined);
}

async function ensureSessionDir(sessionId: string): Promise<void> {
  await mkdir(sessionsDirPath(), { recursive: true, mode: 0o700 });
  await fixOwner(sessionsDirPath());
  await mkdir(sessionDirPath(sessionId), { recursive: true, mode: 0o700 });
  await fixOwner(sessionDirPath(sessionId));
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    if (result.bytesWritten <= 0) throw new Error("Failed to append session history");
    written += result.bytesWritten;
  }
}

export async function appendSessionFrame(sessionId: string, line: string, expectedSize: number): Promise<LogStamp> {
  await ensureSessionDir(sessionId);
  const path = sessionLogPath(sessionId);
  const bytes = Buffer.from(line, "utf8");
  const handle = await open(path, "a", 0o600);
  try {
    const size = (await handle.stat()).size;
    if (size !== expectedSize) throw new Error("session history changed while appending");
    await writeAll(handle, bytes, size);
    await handle.sync();
    if (size === 0) await fixOwner(path);
    return stampOf(await handle.stat());
  } finally {
    await handle.close();
  }
}

export async function replaceFile(temporary: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = errorCode(error);
      const sharing = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !sharing || attempt >= RENAME_ATTEMPTS) throw error;
      await delay(Math.min(25 * 2 ** attempt, 200));
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

export async function rewriteSessionLog(sessionId: string, line: string): Promise<LogStamp> {
  await ensureSessionDir(sessionId);
  const path = sessionLogPath(sessionId);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let committed = false;
  try {
    await writeAll(handle, Buffer.from(line, "utf8"), 0);
    await handle.sync();
    await handle.close();
    await fixOwner(temporary);
    await replaceFile(temporary, path);
    committed = true;
    await syncDirectory(sessionDirPath(sessionId));
    const info = await stat(path);
    return stampOf(info);
  } finally {
    if (!committed) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export async function removeSessionDirectory(sessionId: string): Promise<boolean> {
  const dir = sessionDirPath(sessionId);
  const existed = await stat(dir).then(() => true, () => false);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  forgetSessionState(sessionId);
  return existed;
}

function summaryFromFramePrefix(text: string, accept: (id: string) => boolean): HistorySummary | undefined {
  const marker = text.indexOf(`"summary":`);
  if (marker < 0) return undefined;
  const start = marker + `"summary":`.length;
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const summary = JSON.parse(text.slice(start, index + 1)) as HistorySummary;
          return typeof summary?.id === "string" && accept(summary.id) ? summary : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

async function lineStartBefore(handle: Awaited<ReturnType<typeof open>>, position: number): Promise<number> {
  const chunk = Buffer.allocUnsafe(TAIL_CHUNK_BYTES);
  let end = position;
  while (end > 0) {
    const from = Math.max(0, end - TAIL_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, end - from, from);
    const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return from + newline + 1;
    end = from;
  }
  return 0;
}

async function readTailSummaryAt(
  path: string,
  accept: (id: string) => boolean,
): Promise<{ summary: HistorySummary; stamp: LogStamp } | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (info.size === 0) return undefined;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, info.size - 1);
    const contentEnd = last[0] === 0x0a ? info.size - 1 : (await lineStartBefore(handle, info.size)) - 1;
    if (contentEnd <= 0) return undefined;
    const start = await lineStartBefore(handle, contentEnd);
    const length = Math.min(TAIL_CHUNK_BYTES, contentEnd - start);
    const prefix = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(prefix, 0, length, start);
    const summary = summaryFromFramePrefix(prefix.toString("utf8", 0, bytesRead), accept);
    return summary ? { summary, stamp: stampOf(info) } : undefined;
  } finally {
    await handle.close();
  }
}

export async function readSessionTailSummary(sessionId: string): Promise<{ summary: HistorySummary; stamp: LogStamp } | undefined> {
  return await readTailSummaryAt(sessionLogPath(sessionId), (id) => id === sessionId);
}

export async function readTailSummaryForKey(key: string): Promise<{ summary: HistorySummary; stamp: LogStamp } | undefined> {
  return await readTailSummaryAt(sessionLogPathForKey(key), (id) => sessionKey(id) === key);
}

export async function readSessionLogBytes(sessionId: string): Promise<string> {
  return await readFile(sessionLogPath(sessionId), "utf8");
}
