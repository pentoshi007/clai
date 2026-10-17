import { randomUUID } from "node:crypto";
import { chmod, copyFile, rename, rm, stat } from "node:fs/promises";

function replacementDenied(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "EEXIST" || error.code === "EBUSY";
}

async function replaceWindowsBinary(staged: string, destination: string): Promise<void> {
  const backup = `${destination}.${randomUUID()}.bak`;
  await rename(destination, backup);
  try {
    await rename(staged, destination);
  } catch (error) {
    try {
      await rename(backup, destination);
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`could not restore rtk; the previous executable is preserved at ${backup}: ${detail}`, { cause: error });
    }
    throw error;
  }
  await rm(backup, { force: true }).catch(() => undefined);
}

export async function placeVerifiedBinary(staged: string, destination: string, windows: boolean): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(staged, temporary);
    if (!windows) await chmod(temporary, 0o755);
    try {
      await rename(temporary, destination);
    } catch (error) {
      const existing = await stat(destination).catch(() => undefined);
      if (!windows || !replacementDenied(error) || !existing?.isFile()) throw error;
      await replaceWindowsBinary(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
