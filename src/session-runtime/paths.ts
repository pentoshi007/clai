import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { getDataDir } from "../store/paths.js";

const MAX_UNIX_SOCKET_PATH_BYTES = 96;
const UNIX_SOCKET_KEY_LENGTH = 24;

export function runtimeKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function runtimeSocketKey(sessionId: string): string {
  return runtimeKey(sessionId).slice(0, UNIX_SOCKET_KEY_LENGTH);
}

export function getRuntimeDir(): string {
  return join(getDataDir(), "runtimes");
}

function runtimeOwnerKey(): string {
  return typeof process.getuid === "function"
    ? String(process.getuid())
    : createHash("sha256").update(homedir()).digest("hex").slice(0, 12);
}

function fallbackSocketRoot(): string {
  return join(sep, "tmp", `clai-rt-${runtimeOwnerKey()}`);
}

function legacyFallbackSocketRoot(): string {
  return join(tmpdir(), `clai-runtimes-${runtimeOwnerKey()}`);
}

export function getRuntimeSocketRoot(): string {
  const local = join(getRuntimeDir(), "sockets");
  const sample = join(local, `${"0".repeat(UNIX_SOCKET_KEY_LENGTH)}.sock`);
  return Buffer.byteLength(sample) <= MAX_UNIX_SOCKET_PATH_BYTES
    ? local
    : fallbackSocketRoot();
}

export function runtimeMetadataPath(sessionId: string): string {
  return join(getRuntimeDir(), `${runtimeKey(sessionId)}.json`);
}

export function runtimeLockPath(sessionId: string): string {
  return join(getRuntimeDir(), `${runtimeKey(sessionId)}.lock`);
}

export function runtimeSocketPath(sessionId: string): string {
  const key = process.platform === "win32"
    ? runtimeKey(sessionId)
    : runtimeSocketKey(sessionId);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\clai-runtime-${key}`
    : join(getRuntimeSocketRoot(), `${key}.sock`);
}

async function ensurePrivateFallbackRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`unsafe session runtime socket directory: ${path}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`session runtime socket directory has a different owner: ${path}`);
  }
  await chmod(path, 0o700);
}

export async function ensureRuntimeDirectories(): Promise<void> {
  const runtimeDir = getRuntimeDir();
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700).catch(() => undefined);
  if (process.platform === "win32") return;
  const socketRoot = getRuntimeSocketRoot();
  if (socketRoot === fallbackSocketRoot()) {
    await ensurePrivateFallbackRoot(socketRoot);
    return;
  }
  await mkdir(socketRoot, { recursive: true, mode: 0o700 });
  await chmod(socketRoot, 0o700).catch(() => undefined);
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
}

export function isRuntimeSocketPath(path: string): boolean {
  if (process.platform === "win32") {
    return /^\\\\\.\\pipe\\clai-runtime-[a-f0-9]{32}$/i.test(path);
  }
  if (basename(path).match(/^[a-f0-9]{24}(?:[a-f0-9]{8})?\.sock$/i) === null) {
    return false;
  }
  return [
    getRuntimeSocketRoot(),
    join(getRuntimeDir(), "sockets"),
    legacyFallbackSocketRoot(),
  ].some((root) => inside(root, path));
}
