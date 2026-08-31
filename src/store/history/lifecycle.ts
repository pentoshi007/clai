import { fixOwner, safeExists } from "../../os/permissions.js";
import { readValidatedHistoryIndex, rebuildHistoryIndex } from "../history-index.js";
import { isUnderSessionWorkspaceParent, sessionWorkspaceRoot } from "../session-workspace.js";
import { queueJsonlWrite } from "./jsonl-backend.js";
import { acquireJsonlWriteLock, historyDirPath } from "./jsonl-lock.js";
import { backupDirPath, ensureHistoryRecovered, HistoryRecord, invalidateSessionListCache, jsonlFilePath, jsonlIndexFilePath } from "./recovery.js";
import { getSession } from "./session-queries.js";
import { archiveFilePath, loadDatabase } from "./sqlite-backend.js";
import { open, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

export async function clearAllHistory(): Promise<{
  cleared: boolean;
  detail: string;
}> {
  await ensureHistoryRecovered();
  const details: string[] = [];

  try {
    invalidateSessionListCache();
    const db = await loadDatabase();
    if (db) {
      db.exec(
        "DELETE FROM sessions; DELETE FROM tool_calls; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;",
      );
      details.push("sqlite cleared");
    }
  } catch (error) {
    details.push(
      `sqlite error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const releaseLock = await acquireJsonlWriteLock();
  try {
    const names = await readdir(historyDirPath()).catch(() => [] as string[]);
    const removable = names.filter(
      (name) =>
        name === "history.jsonl" ||
        name === "history.index.json" ||
        name === "history-archive.jsonl" ||
        name === "history-backups" ||
        name.startsWith("history-cleared-") ||
        (name.startsWith("history.jsonl.") && name.endsWith(".tmp")),
    );
    await Promise.all(
      removable.map((name) =>
        rm(join(historyDirPath(), name), { recursive: true, force: true }),
      ),
    );
    details.push("history, index, archives, and backups deleted");
  } catch (error) {
    details.push(
      `history file error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await releaseLock();
  }

  try {
    const { clearAllPlans } = await import("../plan.js");
    await clearAllPlans();
    details.push("plans cleared");
  } catch {
    details.push("plan store unavailable");
  }
  invalidateSessionListCache();
  return { cleared: true, detail: details.join("; ") };
}

const HISTORY_FILTER_CHUNK_BYTES = 64 * 1024;

async function* readHistoryJsonlLines(
  path: string,
): AsyncGenerator<Buffer, void, void> {
  const handle = await open(path, "r");
  const chunk = Buffer.allocUnsafe(HISTORY_FILTER_CHUNK_BYTES);
  let carryChunks: Buffer[] = [];
  let carryLen = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      let start = 0;
      while (true) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0 || newline >= bytesRead) break;
        const segment = chunk.subarray(start, newline + 1);
        if (carryLen > 0) {
          yield Buffer.concat([...carryChunks, segment], carryLen + segment.length);
          carryChunks = [];
          carryLen = 0;
        } else {
          yield Buffer.from(segment);
        }
        start = newline + 1;
      }
      if (start < bytesRead) {
        carryChunks.push(Buffer.from(chunk.subarray(start, bytesRead)));
        carryLen += bytesRead - start;
      }
    }
    if (carryLen > 0) yield Buffer.concat(carryChunks, carryLen);
  } finally {
    await handle.close();
  }
}

function parseHistoryJsonlLine(line: Buffer): {
  valid: boolean;
  id?: string | undefined;
} {
  try {
    const value = JSON.parse(line.toString("utf8")) as unknown;
    if (value === null) return { valid: false };
    return {
      valid: true,
      ...(value && typeof value === "object" && !Array.isArray(value)
        ? {
            id:
              typeof (value as { id?: unknown }).id === "string"
                ? (value as { id: string }).id
                : undefined,
          }
        : {}),
    };
  } catch {
    return { valid: false };
  }
}

async function historyFileContainsSession(
  path: string,
  sessionId: string,
): Promise<boolean> {
  if (!(await safeExists(path))) return false;
  for await (const line of readHistoryJsonlLines(path)) {
    if (parseHistoryJsonlLine(line).id === sessionId) return true;
  }
  return false;
}

async function writeAllHistoryBytes(
  handle: FileHandle,
  bytes: Buffer,
  position: number,
): Promise<number> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("failed to write history data");
    }
    written += result.bytesWritten;
  }
  return position + written;
}

async function removeSessionFromHistoryFile(
  path: string,
  sessionId: string,
  options: { knownToExist?: boolean } = {},
): Promise<boolean> {
  if (
    !options.knownToExist &&
    !(await historyFileContainsSession(path, sessionId))
  ) {
    return false;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let output: FileHandle | undefined;
  let committed = false;
  let retained = false;
  try {
    output = await open(temporary, "wx", 0o600);
    let outputPosition = 0;
    for await (const line of readHistoryJsonlLines(path)) {
      const parsed = parseHistoryJsonlLine(line);
      if (!parsed.valid || parsed.id === sessionId) continue;
      outputPosition = await writeAllHistoryBytes(
        output,
        line,
        outputPosition,
      );
      retained = true;
    }
    await output.close();
    output = undefined;
    if (!retained) {
      await rm(temporary, { force: true });
      await rm(path, { force: true });
      committed = true;
      return true;
    }
    await rename(temporary, path);
    committed = true;
    await fixOwner(path);
    return true;
  } finally {
    await output?.close().catch(() => undefined);
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function removeSessionFromActiveHistory(
  sessionId: string,
): Promise<boolean> {
  const path = jsonlFilePath();
  let entries = await readValidatedHistoryIndex(path, jsonlIndexFilePath());
  if (!entries) {
    entries = await rebuildHistoryIndex<HistoryRecord>(
      path,
      jsonlIndexFilePath(),
    );
  }
  if (!entries.some((entry) => entry.id === sessionId)) return false;
  const removed = await removeSessionFromHistoryFile(path, sessionId, {
    knownToExist: true,
  });
  if (!removed) return false;
  if (!(await safeExists(path))) {
    await writeFile(path, "", { mode: 0o600 });
  }
  await rebuildHistoryIndex<HistoryRecord>(path, jsonlIndexFilePath());
  await Promise.all([
    fixOwner(path),
    fixOwner(jsonlIndexFilePath()),
  ]);
  return true;
}

export async function deleteSession(sessionId: string): Promise<{ deleted: boolean; detail: string }> {
  const id = sessionId.trim();
  if (!id) return { deleted: false, detail: "missing session id" };
  let deletedFromJsonl = false;
  let deletedFromArchive = false;
  let deletedFromBackup = false;
  let deletedFromSqlite = false;
  let historyWriteFailed = false;
  await queueJsonlWrite(async () => {
    deletedFromJsonl = await removeSessionFromActiveHistory(id);
    deletedFromArchive = await removeSessionFromHistoryFile(archiveFilePath(), id);
    const backupNames = (await readdir(backupDirPath()).catch(() => [] as string[]))
      .filter((name) => name.startsWith("history-") && name.endsWith(".jsonl"));
    for (const name of backupNames) {
      deletedFromBackup =
        (await removeSessionFromHistoryFile(join(backupDirPath(), name), id)) ||
        deletedFromBackup;
    }
  }, () => {
    historyWriteFailed = true;
  });
  if (historyWriteFailed) {
    return { deleted: false, detail: "could not remove the session from history files" };
  }
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(id);
      const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      const changes = (result as unknown as { changes: number }).changes ?? 0;
      if (changes > 0) deletedFromSqlite = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
      invalidateSessionListCache();
    }
  } catch (error) {
    return {
      deleted: false,
      detail: `could not remove the session from the history database: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  invalidateSessionListCache();
  if (!deletedFromJsonl && !deletedFromArchive && !deletedFromBackup && !deletedFromSqlite) {
    const existing = await getSession(id);
    if (existing) return { deleted: false, detail: "failed to delete" };
    return { deleted: false, detail: "session not found" };
  }
  return { deleted: true, detail: `deleted ${id}` };
}

async function releasePurgedSessionModel(sessionId: string): Promise<void> {
  try {
    const { releaseSessionModel } = await import("../session-model.js");
    await releaseSessionModel(sessionId);
  } catch {
    void 0;
  }
}

export async function purgeSession(sessionId: string): Promise<{
  deleted: boolean;
  detail: string;
  removedWorkspace: boolean;
  removedPlan: boolean;
}> {
  const id = sessionId.trim();
  if (!id) {
    return {
      deleted: false,
      detail: "missing session id",
      removedWorkspace: false,
      removedPlan: false,
    };
  }
  const record = await getSession(id);
  const workspaceFolder = record?.workspaceFolder?.trim();
  const result = await deleteSession(id);
  if (!result.deleted) {
    return { ...result, removedWorkspace: false, removedPlan: false };
  }

  let removedPlan = false;
  try {
    const { deletePlan } = await import("../plan.js");
    await deletePlan(id);
    removedPlan = true;
  } catch {
    removedPlan = false;
  }

  try {
    const { releaseSessionScope } = await import("../scope.js");
    await releaseSessionScope(id);
  } catch {
    void 0;
  }

  await releasePurgedSessionModel(id);

  let removedWorkspace = false;
  if (workspaceFolder) {
    try {
      const root = sessionWorkspaceRoot(workspaceFolder);
      if (isUnderSessionWorkspaceParent(root)) {
        await rm(root, { recursive: true, force: true });
        removedWorkspace = true;
      }
    } catch {
      removedWorkspace = false;
    }
  }

  const extras: string[] = [];
  if (removedWorkspace) extras.push("artifacts");
  if (removedPlan) extras.push("plan");
  return {
    deleted: true,
    detail: extras.length > 0 ? `${result.detail} + ${extras.join(" + ")}` : result.detail,
    removedWorkspace,
    removedPlan,
  };
}
