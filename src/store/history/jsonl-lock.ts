import { getHistoryDir } from "../paths.js";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/** Live paths so CLAI_DATA_DIR / CLAI_HISTORY_DIR always apply (and tests work). */
export function historyDirPath(): string {
  return getHistoryDir();
}

function jsonlLockFilePath(): string {
  return join(historyDirPath(), "history.jsonl.lock");
}

function jsonlLockReaperPath(): string {
  return join(historyDirPath(), "history.jsonl.lock.reaper");
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
export async function acquireJsonlWriteLock(): Promise<() => Promise<void>> {
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
