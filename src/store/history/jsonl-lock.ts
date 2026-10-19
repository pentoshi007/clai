import { getHistoryDir } from "../paths.js";
import { fixOwner } from "../../os/permissions.js";
import { processIdentity, processIdentityTracker } from "../../os/process-identity.js";
import { processAlive } from "../../os/process-tree.js";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export function historyDirPath(): string {
  return getHistoryDir();
}

const LOCK_INITIALIZE_MS = 5_000;
const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = 1_000;
const LOCK_RETRIES = 400;
const LOCK_TIMEOUT_MS = 20_000;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

let ownIdentity: string | undefined = process.platform === "linux" ? processIdentity(process.pid) : undefined;
let ownIdentityPending: Promise<void> | undefined;

function warmOwnIdentity(): void {
  if (ownIdentity !== undefined || ownIdentityPending || process.platform === "win32") return;
  ownIdentityPending = processIdentityTracker.captureAsync(process.pid)
    .then((identity) => { ownIdentity = identity; })
    .catch(() => undefined);
}

function lockToken(): string {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return ownIdentity ? `${token}-${ownIdentity}` : token;
}

interface LockObservation {
  readonly token: string | undefined;
  readonly ino: number;
  readonly mtimeMs: number;
}

async function observeLock(path: string): Promise<LockObservation | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return undefined;
  const token = await readFile(path, "utf8").catch(() => undefined);
  return { token, ino: info.ino, mtimeMs: info.mtimeMs };
}

async function lockIsAbandoned(observed: LockObservation): Promise<boolean> {
  const age = Date.now() - observed.mtimeMs;
  if (observed.token === undefined) return age > LOCK_STALE_MS;
  const [pidText, , , identity] = observed.token.split("-");
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return age > LOCK_INITIALIZE_MS;
  if (!processAlive(pid)) return true;
  if (!identity || pid === process.pid || age <= LOCK_HEARTBEAT_MS * 3) return false;
  return await processIdentityTracker.compareAsync(pid, identity, { refresh: true }) === "mismatch";
}

async function removeIfUnchanged(path: string, observed: LockObservation): Promise<void> {
  const current = await observeLock(path);
  if (!current || current.ino !== observed.ino || current.token !== observed.token) return;
  if (observed.token === undefined && current.mtimeMs !== observed.mtimeMs) return;
  await rm(path, { force: true });
}

async function reapStaleLock(path: string): Promise<void> {
  const reaperPath = `${path}.reaper`;
  let reaper: Awaited<ReturnType<typeof open>>;
  const reaperToken = lockToken();
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
    const existing = await observeLock(reaperPath);
    const stale = existing && (await lockIsAbandoned(existing) || Date.now() - existing.mtimeMs > LOCK_STALE_MS);
    if (existing && stale) await removeIfUnchanged(reaperPath, existing).catch(() => undefined);
    return;
  }
  try {
    const observed = await observeLock(path);
    if (observed && await lockIsAbandoned(observed)) await removeIfUnchanged(path, observed);
  } finally {
    await reaper.close().catch(() => undefined);
    const current = await readFile(reaperPath, "utf8").catch(() => undefined);
    if (current === reaperToken) await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

export async function acquireStorageWriteLock(path: string, label = "history"): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fixOwner(dirname(path));
  warmOwnIdentity();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const token = lockToken();
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(token);
        await fixOwner(path);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
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
  throw new Error(`timed out waiting for ${label} write lock`);
}

export function acquireJsonlWriteLock(): Promise<() => Promise<void>> {
  return acquireStorageWriteLock(join(historyDirPath(), "history.jsonl.lock"));
}
