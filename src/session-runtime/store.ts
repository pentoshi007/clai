import { chmod, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { processIdentityTracker } from "../os/process-identity.js";
import { processAlive } from "../os/process-tree.js";
import { RUNTIME_PROTOCOL_VERSION, type RuntimeMetadata } from "./types.js";
import {
  ensureRuntimeDirectories,
  getRuntimeDir,
  runtimeKey,
  runtimeLockPath,
  runtimeMetadataPath,
} from "./paths.js";

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RUNTIME_FILES = 512;

export interface RuntimeLease {
  readonly sessionId: string;
  readonly path: string;
  release(): Promise<void>;
}

function isString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isRuntimeMetadata(value: unknown): value is RuntimeMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RuntimeMetadata>;
  return (
    record.version === RUNTIME_PROTOCOL_VERSION &&
    isString(record.sessionId, 256) &&
    Number.isSafeInteger(record.hostPid) &&
    Number(record.hostPid) > 0 &&
    isString(record.socketPath) &&
    isString(record.token, 256) &&
    /^[a-f0-9]{64}$/i.test(record.token) &&
    isString(record.cwd) &&
    isString(record.startedAt, 64) &&
    isString(record.updatedAt, 64) &&
    ["starting", "running", "stopping", "failed"].includes(String(record.phase)) &&
    typeof record.busy === "boolean" &&
    typeof record.attached === "boolean"
  );
}

async function readMetadataPath(path: string): Promise<RuntimeMetadata | undefined> {
  try {
    const raw = await readFile(path);
    if (raw.length > MAX_METADATA_BYTES) return undefined;
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return isRuntimeMetadata(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createRuntimeToken(): string {
  return randomBytes(32).toString("hex");
}

export async function writeRuntimeMetadata(metadata: RuntimeMetadata): Promise<void> {
  await ensureRuntimeDirectories();
  const path = runtimeMetadataPath(metadata.sessionId);
  const temporary = join(
    getRuntimeDir(),
    `.${runtimeKey(metadata.sessionId)}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`,
  );
  const body = `${JSON.stringify(metadata)}\n`;
  if (Buffer.byteLength(body) > MAX_METADATA_BYTES) {
    throw new Error("runtime metadata exceeded its size limit");
  }
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readRuntimeMetadata(
  sessionId: string,
): Promise<RuntimeMetadata | undefined> {
  return await readMetadataPath(runtimeMetadataPath(sessionId));
}

export async function listRuntimeMetadata(): Promise<RuntimeMetadata[]> {
  await ensureRuntimeDirectories();
  let names: string[];
  try {
    names = await readdir(getRuntimeDir());
  } catch {
    return [];
  }
  const paths = names
    .filter((name) => /^[a-f0-9]{32}\.json$/i.test(name))
    .slice(0, MAX_RUNTIME_FILES)
    .map((name) => join(getRuntimeDir(), basename(name)));
  const records = await Promise.all(paths.map(readMetadataPath));
  return records.filter((record): record is RuntimeMetadata => Boolean(record));
}

export async function deleteRuntimeMetadata(sessionId: string): Promise<void> {
  await rm(runtimeMetadataPath(sessionId), { force: true }).catch(() => undefined);
}

export async function deleteRuntimeLock(sessionId: string): Promise<void> {
  await rm(runtimeLockPath(sessionId), { force: true }).catch(() => undefined);
}

export async function reapStaleRuntimeLock(sessionId: string): Promise<boolean> {
  const path = runtimeLockPath(sessionId);
  let owner: { pid?: unknown; identity?: unknown };
  try {
    const raw = await readFile(path, "utf8");
    owner = JSON.parse(raw) as { pid?: unknown; identity?: unknown };
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) return false;
  const pid = Number(owner.pid);
  const identity = typeof owner.identity === "string" ? owner.identity : undefined;
  const comparison = processIdentityTracker.compare(pid, identity);
  const stale =
    comparison === "gone" ||
    comparison === "mismatch" ||
    (comparison === "unknown" && !processAlive(pid));
  if (!stale) return false;
  await rm(path, { force: true }).catch(() => undefined);
  return true;
}

export async function tryAcquireRuntimeLease(
  sessionId: string,
): Promise<RuntimeLease | undefined> {
  await ensureRuntimeDirectories();
  const path = runtimeLockPath(sessionId);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  await handle.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      identity: processIdentityTracker.capture(process.pid, { refresh: true }),
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  await handle.sync().catch(() => undefined);
  let released = false;
  return {
    sessionId,
    path,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}
