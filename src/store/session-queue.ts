import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedQueuedPrompt } from "../app/ports/persistence-port.js";
import { sessionDirPath } from "./history/session-paths.js";
import { redactSecretsCached } from "./redaction-cache.js";

export function queuedPromptsPath(sessionId: string): string {
  return join(sessionDirPath(sessionId), "queue.json");
}

function parsePrompt(value: unknown): PersistedQueuedPrompt {
  if (!value || typeof value !== "object" || !("id" in value) || !("text" in value) ||
      typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id < 1 ||
      typeof value.text !== "string" || !value.text.trim()) throw new Error("invalid queued prompt");
  const displayPrompt = "displayPrompt" in value ? value.displayPrompt : undefined;
  if (displayPrompt !== undefined && displayPrompt !== null && typeof displayPrompt !== "string") {
    throw new Error("invalid queued prompt display text");
  }
  return { id: value.id, text: value.text, ...(displayPrompt !== undefined ? { displayPrompt } : {}) };
}

export function loadQueuedPrompts(sessionId: string): readonly PersistedQueuedPrompt[] {
  let body: string;
  try { body = readFileSync(queuedPromptsPath(sessionId), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("sessionId" in value) || value.sessionId !== sessionId || !("prompts" in value) || !Array.isArray(value.prompts)) {
    throw new Error("invalid session queue");
  }
  const prompts = value.prompts.map(parsePrompt);
  if (new Set(prompts.map((entry) => entry.id)).size !== prompts.length) throw new Error("duplicate queued prompt ids");
  return prompts;
}

export function saveQueuedPrompts(sessionId: string, prompts: readonly PersistedQueuedPrompt[]): void {
  const path = queuedPromptsPath(sessionId);
  if (prompts.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const directory = sessionDirPath(sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.queue-${randomUUID()}.tmp`);
  const safePrompts = prompts.map((entry) => ({
    ...entry,
    text: redactSecretsCached(entry.text),
    ...(typeof entry.displayPrompt === "string" ? { displayPrompt: redactSecretsCached(entry.displayPrompt) } : {}),
  }));
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, sessionId, prompts: safePrompts }), { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
