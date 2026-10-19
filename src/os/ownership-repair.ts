import { constants, type Stats } from "node:fs";
import { lchown, lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { reportOwnershipFailure } from "./permissions.js";
import { getInvokingUser, type InvokingUser } from "./user-identity.js";

export interface OwnershipRepairResult {
  readonly repaired: number;
  readonly complete: boolean;
}

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function handBack(path: string, info: Stats, user: InvokingUser): Promise<boolean> {
  if (info.isSymbolicLink()) {
    await lchown(path, user.uid, user.gid);
    return true;
  }
  if (!info.isFile() && !info.isDirectory()) return false;
  const handle = await open(path, OPEN_FLAGS);
  try {
    const current = await handle.stat();
    if (current.ino !== info.ino || current.dev !== info.dev || current.uid !== 0) return false;
    if (!current.isDirectory() && current.nlink !== 1) return false;
    await handle.chown(user.uid, user.gid);
    return true;
  } finally {
    await handle.close();
  }
}

export async function repairOwnership(
  roots: readonly string[],
  deadline = Number.POSITIVE_INFINITY,
): Promise<OwnershipRepairResult> {
  const user = getInvokingUser();
  if (!user) return { repaired: 0, complete: true };
  const pending = [...new Set(roots)];
  const visited = new Set<string>();
  let repaired = 0;
  while (pending.length > 0) {
    if (Date.now() >= deadline) return { repaired, complete: false };
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    if (info.uid === 0) {
      try {
        if (await handBack(path, info, user)) repaired += 1;
      } catch (error) {
        reportOwnershipFailure(path, error, user.username);
      }
    }
    if (!info.isDirectory()) continue;
    const entries = await readdir(path).catch(() => []);
    for (const entry of entries) pending.push(join(path, entry));
  }
  return { repaired, complete: true };
}
