import { createHash } from "node:crypto";
import { join } from "node:path";
import { historyDirPath } from "./jsonl-lock.js";

export const SESSION_LOG_NAME = "session.jsonl";

export function sessionsDirPath(): string {
  return join(historyDirPath(), "sessions");
}

export function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function sessionDirPath(sessionId: string): string {
  return join(sessionsDirPath(), sessionKey(sessionId));
}

export function sessionLogPath(sessionId: string): string {
  return join(sessionDirPath(sessionId), SESSION_LOG_NAME);
}

export function sessionLogPathForKey(key: string): string {
  return join(sessionsDirPath(), key, SESSION_LOG_NAME);
}

export function sessionLockPath(sessionId: string): string {
  return join(sessionsDirPath(), `${sessionKey(sessionId)}.lock`);
}

export function sessionIndexPath(): string {
  return join(sessionsDirPath(), "index.json");
}

export function sessionIndexLockPath(): string {
  return join(sessionsDirPath(), "index.json.lock");
}

export function migrationMarkerPath(): string {
  return join(sessionsDirPath(), ".migrated-v1.json");
}

export function isSessionKey(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}
