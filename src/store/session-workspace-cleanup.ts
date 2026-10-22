import { lstat, mkdir, opendir, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { processAlive } from "../os/process-tree.js";
import { isWorkspaceActive, WORKSPACE_OWNERS_DIR } from "./session-workspace-activity.js";

export const SESSION_SCRATCH_RETENTION_MS = 10 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SESSION_FOLDER = /^[0-9a-f]{6}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}(?:-[0-9a-f]{2})?$/i;
const LOCK_NAME = ".clai-cleanup-lock";
const CHECKPOINT_NAME = ".clai-cleanup-at";
const MAX_DEPTH = 32;

let timer: ReturnType<typeof setTimeout> | undefined;
let scheduledParent: string | undefined;
let running: Promise<number> | undefined;
let runningParent: string | undefined;
let scheduleGeneration = 0;

class CleanupPacer {
  private operations = 0;

  async step(): Promise<void> {
    this.operations += 1;
    if (this.operations % 32 === 0) {
      await new Promise<void>((done) => setTimeout(done, 10));
    }
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function hasLiveOwner(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return true;
    const pacer = new CleanupPacer();
    const dir = await opendir(path, { bufferSize: 16 });
    for await (const owner of dir) {
      await pacer.step();
      if (!owner.isFile() || !/^\d+$/.test(owner.name)) return true;
      const pid = Number(owner.name);
      if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) return true;
    }
    return false;
  } catch (error) {
    return !missing(error);
  }
}

async function treeIsExpired(path: string, cutoff: number, pacer: CleanupPacer, depth = 0): Promise<boolean> {
  await pacer.step();
  const info = await lstat(path);
  if (!Number.isFinite(info.mtimeMs) || info.mtimeMs >= cutoff) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) return true;
  if (depth >= MAX_DEPTH) return false;
  const dir = await opendir(path, { bufferSize: 16 });
  for await (const entry of dir) {
    if (!await treeIsExpired(join(path, entry.name), cutoff, pacer, depth + 1)) return false;
  }
  return true;
}

async function removeExpiredTree(
  path: string,
  root: string,
  cutoff: number,
  pacer: CleanupPacer,
  depth = 0,
): Promise<boolean> {
  await pacer.step();
  if (isWorkspaceActive(root) || await hasLiveOwner(join(root, WORKSPACE_OWNERS_DIR))) return false;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    if (info.mtimeMs >= cutoff) return false;
    await unlink(path);
    return true;
  }
  if (depth >= MAX_DEPTH) return false;
  const dir = await opendir(path, { bufferSize: 16 });
  for await (const entry of dir) {
    if (entry.name === WORKSPACE_OWNERS_DIR && path === root) continue;
    if (!await removeExpiredTree(join(path, entry.name), root, cutoff, pacer, depth + 1)) return false;
  }
  if (path === root) {
    if (await hasLiveOwner(join(root, WORKSPACE_OWNERS_DIR))) return false;
    const owners = join(root, WORKSPACE_OWNERS_DIR);
    try {
      const entries = await opendir(owners, { bufferSize: 16 });
      for await (const entry of entries) {
        await pacer.step();
        if (!/^\d+$/.test(entry.name) || processAlive(Number(entry.name))) return false;
        await unlink(join(owners, entry.name));
      }
      await rmdir(owners);
    } catch (error) {
      if (!missing(error)) return false;
    }
  }
  await rmdir(path);
  return true;
}

async function acquireCleanupLock(parent: string, now: number, reaped = false): Promise<(() => Promise<void>) | undefined> {
  const path = join(parent, LOCK_NAME);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (reaped || (error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") return undefined;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < 60_000) return undefined;
    if (await hasLiveOwner(path)) return undefined;
    const entries = await opendir(path, { bufferSize: 16 });
    for await (const entry of entries) {
      if (!/^\d+$/.test(entry.name) || processAlive(Number(entry.name))) return undefined;
      await unlink(join(path, entry.name));
    }
    await rmdir(path);
    return await acquireCleanupLock(parent, now, true);
  }
  const owner = join(path, String(process.pid));
  try {
    await writeFile(owner, "", { flag: "wx", mode: 0o600 });
  } catch {
    await rmdir(path).catch(() => undefined);
    return undefined;
  }
  return async () => {
    await unlink(owner).catch(() => undefined);
    await rmdir(path).catch(() => undefined);
  };
}

async function runCleanup(parent: string, now: number): Promise<number> {
  let release: (() => Promise<void>) | undefined;
  let removed = 0;
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) return 0;
    const checkpoint = join(parent, CHECKPOINT_NAME);
    const previous = await lstat(checkpoint).catch(() => undefined);
    if (previous && (previous.isSymbolicLink() || now - previous.mtimeMs < CLEANUP_INTERVAL_MS)) return 0;
    release = await acquireCleanupLock(parent, now);
    if (!release) return 0;
    const completedElsewhere = await lstat(checkpoint).catch(() => undefined);
    if (completedElsewhere && now - completedElsewhere.mtimeMs < CLEANUP_INTERVAL_MS) return 0;
    const cutoff = now - SESSION_SCRATCH_RETENTION_MS;
    const pacer = new CleanupPacer();
    const dir = await opendir(parent, { bufferSize: 16 });
    for await (const entry of dir) {
      await pacer.step();
      if (!entry.isDirectory() || !SESSION_FOLDER.test(entry.name)) continue;
      const root = join(parent, entry.name);
      if (isWorkspaceActive(root)) continue;
      try {
        const observed = await lstat(root);
        if (!observed.isDirectory() || observed.isSymbolicLink() || observed.mtimeMs >= cutoff) continue;
        if (typeof process.getuid === "function" && observed.uid !== process.getuid()) continue;
        if (await hasLiveOwner(join(root, WORKSPACE_OWNERS_DIR))) continue;
        if (!await treeIsExpired(root, cutoff, pacer)) continue;
        const current = await lstat(root);
        if (current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) continue;
        if (isWorkspaceActive(root) || await hasLiveOwner(join(root, WORKSPACE_OWNERS_DIR))) continue;
        if (await removeExpiredTree(root, root, cutoff, pacer)) removed += 1;
      } catch {
      }
    }
    await writeFile(checkpoint, "", { mode: 0o600 });
    const completed = new Date(now);
    await utimes(checkpoint, completed, completed);
  } catch {
  } finally {
    await release?.();
  }
  return removed;
}

export function cleanupSessionWorkspaces(parent: string, now = Date.now()): Promise<number> {
  const resolved = resolve(parent);
  if (running) {
    return runningParent === resolved
      ? running
      : running.then(() => cleanupSessionWorkspaces(resolved, now));
  }
  const pending = runCleanup(resolved, now).finally(() => {
    if (running === pending) {
      running = undefined;
      runningParent = undefined;
    }
  });
  running = pending;
  runningParent = resolved;
  return pending;
}

export function scheduleSessionWorkspaceCleanup(parent: string): void {
  const resolved = resolve(parent);
  if (scheduledParent === resolved) return;
  stopSessionWorkspaceCleanup();
  scheduledParent = resolved;
  const generation = scheduleGeneration;
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void cleanupSessionWorkspaces(resolved).finally(() => {
        if (scheduleGeneration === generation) schedule(CLEANUP_INTERVAL_MS);
      });
    }, delay);
    timer.unref();
  };
  schedule(5_000);
}

export function stopSessionWorkspaceCleanup(): void {
  scheduleGeneration += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
  scheduledParent = undefined;
}
