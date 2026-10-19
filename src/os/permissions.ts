import { chownSync, statSync } from "node:fs";
import { chown, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { getInvokingUser } from "./user-identity.js";

export interface OwnershipFailure {
  readonly path: string;
  readonly code: string;
  readonly username: string;
}

const ownershipListeners = new Set<(failure: OwnershipFailure) => void>();

export function onOwnershipFailure(listener: (failure: OwnershipFailure) => void): () => void {
  ownershipListeners.add(listener);
  return () => { ownershipListeners.delete(listener); };
}

export function reportOwnershipFailure(path: string, error: unknown, username: string): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
  if (code === "ENOENT") return;
  for (const listener of ownershipListeners) listener({ path, code, username });
}

export function fixOwnerSync(path: string): void {
  const user = getInvokingUser();
  if (!user) return;
  try { chownSync(path, user.uid, user.gid); } catch (error) { reportOwnershipFailure(path, error, user.username); }
}

export async function fixOwner(path: string): Promise<void> {
  const user = getInvokingUser();
  if (!user) return;
  try { await chown(path, user.uid, user.gid); } catch (error) { reportOwnershipFailure(path, error, user.username); }
}

export function handlePermissionError(err: any): never {
  if (err && err.code === "EACCES") {
    const configPath = err.path || "your configuration directory";

    let chownDir = configPath;
    const claiConfigIndex = configPath.indexOf("clai-nodejs");
    const dotClaiIndex = configPath.indexOf(".clai");
    if (claiConfigIndex !== -1) {
      chownDir = configPath.slice(0, claiConfigIndex + "clai-nodejs".length);
    } else if (dotClaiIndex !== -1) {
      chownDir = configPath.slice(0, dotClaiIndex + ".clai".length);
    } else {
      try {
        chownDir = dirname(configPath);
      } catch {
        chownDir = configPath;
      }
    }

    throw new Error(
      `Permission denied accessing config/history file or directory.\n` +
        `Path: ${configPath}\n` +
        `This usually happens if clai was previously run with sudo or as root, leaving files owned by root.\n` +
        `Fix it by restoring ownership to your current user:\n` +
        `  sudo chown -R $(whoami) "${chownDir}"`,
      { cause: err },
    );
  }
  throw err;
}

export function safeExistsSync(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return false;
    }
    if (err.code === "EACCES") {
      handlePermissionError(err);
    }
    throw err;
  }
}

export async function safeExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return false;
    }
    if (err.code === "EACCES") {
      handlePermissionError(err);
    }
    throw err;
  }
}

