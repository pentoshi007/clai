import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getDataDir } from "../store/paths.js";
import { McpTransportError } from "./transport.js";

export async function withMcpStorageLock<T>(
  key: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = join(getDataDir(), "mcp-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);
  const owner = join(lock, "owner");
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (signal?.aborted)
      throw new McpTransportError("cancelled", "MCP storage operation cancelled.");
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeFile(owner, token, { mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(owner, "utf8").catch(() => undefined);
      const pid = Number(existing?.split(":")[0]);
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (failure) {
          alive = (failure as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      const info = await stat(lock).catch(() => undefined);
      const abandoned = !existing && info && Date.now() - info.mtimeMs > 5_000;
      if (!alive || abandoned) {
        const reaper = `${lock}.reaper`;
        let acquired = false;
        try {
          await mkdir(reaper, { mode: 0o700 });
          acquired = true;
          if ((await readFile(owner, "utf8").catch(() => undefined)) === existing)
            await rm(lock, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const reaperInfo = await stat(reaper).catch(() => undefined);
          if (reaperInfo && Date.now() - reaperInfo.mtimeMs > 5_000)
            await rm(reaper, { recursive: true, force: true });
        } finally {
          if (acquired) await rm(reaper, { recursive: true, force: true });
        }
        if (acquired) continue;
      }
      if (Date.now() >= deadline)
        throw new McpTransportError(
          "timeout",
          "Timed out waiting for another MCP storage operation to finish.",
        );
      await delay(50);
    }
  }
  try {
    return await operation();
  } finally {
    if ((await readFile(owner, "utf8").catch(() => undefined)) === token)
      await rm(lock, { recursive: true, force: true });
  }
}
