import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fixOwner } from "../os/permissions.js";

const adopted = new Map<string, Promise<void>>();

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function move(legacy: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await fixOwner(dirname(target));
  try {
    await rename(legacy, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(legacy, target);
    await rm(legacy, { force: true });
  }
  await fixOwner(target);
}

export function adoptLegacyFile(target: string, legacy: string): Promise<void> {
  if (resolve(target) === resolve(legacy)) return Promise.resolve();
  const key = `${resolve(legacy)}\u0000${resolve(target)}`;
  let pending = adopted.get(key);
  if (!pending) {
    pending = (async () => {
      if (await exists(target) || !await exists(legacy)) return;
      await move(legacy, target);
    })().catch(() => undefined);
    adopted.set(key, pending);
  }
  return pending;
}
