import { getHistoryDir } from "../paths.js";
import { fixOwner } from "../../os/permissions.js";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export function historyDirPath(): string {
  return getHistoryDir();
}

const LOCK_INITIALIZE_MS = 5_000;
const LOCK_RETRIES = 400;
const LOCK_TIMEOUT_MS = 20_000;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockIsAbandoned(token: string | undefined, modifiedAt: number): boolean {
  const pid = Number(token?.split("-")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return token !== undefined && Date.now() - modifiedAt > LOCK_INITIALIZE_MS;
  }
  return !isPidAlive(pid);
}

async function reapStaleLock(path: string): Promise<void> {
  const reaperPath = `${path}.reaper`;
  let reaper: Awaited<ReturnType<typeof open>>;
  const reaperToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    reaper = await open(reaperPath, "wx", 0o600);
    try {
      await reaper.writeFile(reaperToken);
      await fixOwner(reaperPath);
    } catch (error) {
      await reaper.close().catch(() => undefined);
      await rm(reaperPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existingToken = await readFile(reaperPath, "utf8").catch(() => undefined);
    const reaperStat = await stat(reaperPath).catch(() => undefined);
    if (!reaperStat || !lockIsAbandoned(existingToken, reaperStat.mtimeMs)) return;
    const confirmed = await readFile(reaperPath, "utf8").catch(() => undefined);
    if (confirmed !== undefined && confirmed === existingToken) {
      await rm(reaperPath, { force: true }).catch(() => undefined);
    }
    return;
  }
  try {
    const token = await readFile(path, "utf8").catch(() => undefined);
    const lockStat = await stat(path).catch(() => undefined);
    if (!lockStat || !lockIsAbandoned(token, lockStat.mtimeMs)) return;
    const confirmed = await readFile(path, "utf8").catch(() => undefined);
    if (confirmed !== undefined && confirmed === token) await rm(path, { force: true });
  } finally {
    await reaper.close().catch(() => undefined);
    const current = await readFile(reaperPath, "utf8").catch(() => undefined);
    if (current === reaperToken) await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

export async function acquireStorageWriteLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fixOwner(dirname(path));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(token);
        await fixOwner(path);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => undefined);
        const currentToken = await readFile(path, "utf8").catch(() => undefined);
        if (currentToken === token) await rm(path, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt + 1 >= LOCK_RETRIES || Date.now() >= deadline) break;
      await reapStaleLock(path);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
    }
  }
  throw new Error("timed out waiting for history write lock");
}

export function acquireJsonlWriteLock(): Promise<() => Promise<void>> {
  return acquireStorageWriteLock(join(historyDirPath(), "history.jsonl.lock"));
}
