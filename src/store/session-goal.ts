import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedGoal, PersistedGoalPause } from "../app/ports/persistence-port.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../agent/goal/goal-prompts.js";
import { sessionDirPath } from "./history/session-paths.js";
import { redactSecretsCached } from "./redaction-cache.js";

export function sessionGoalPath(sessionId: string): string {
  return join(sessionDirPath(sessionId), "goal.json");
}

function parsePause(value: unknown): PersistedGoalPause | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("reason" in value) || typeof value.reason !== "string" ||
      !("resumeOnPrompt" in value) || typeof value.resumeOnPrompt !== "boolean") {
    throw new Error("invalid goal pause");
  }
  return { reason: value.reason, resumeOnPrompt: value.resumeOnPrompt };
}

function parseGoal(value: unknown): PersistedGoal {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id ||
      !("objective" in value) || typeof value.objective !== "string" || !value.objective.trim() ||
      value.objective.length > MAX_GOAL_OBJECTIVE_CHARS ||
      !("status" in value) || (value.status !== "active" && value.status !== "paused") ||
      !("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    throw new Error("invalid session goal");
  }
  const pause = parsePause("pause" in value ? value.pause : undefined);
  return {
    id: value.id,
    objective: value.objective,
    status: value.status,
    createdAt: value.createdAt,
    ...(value.status === "paused" && pause ? { pause } : {}),
  };
}

export function loadSessionGoal(sessionId: string): PersistedGoal | undefined {
  let body: string;
  try { body = readFileSync(sessionGoalPath(sessionId), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("sessionId" in value) || value.sessionId !== sessionId || !("goal" in value)) {
    throw new Error("invalid session goal file");
  }
  return parseGoal(value.goal);
}

export function saveSessionGoal(sessionId: string, goal: PersistedGoal | undefined): void {
  const path = sessionGoalPath(sessionId);
  if (!goal) {
    rmSync(path, { force: true });
    return;
  }
  const directory = sessionDirPath(sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.goal-${randomUUID()}.tmp`);
  const safeGoal: PersistedGoal = {
    ...goal,
    objective: redactSecretsCached(goal.objective),
    ...(goal.pause ? { pause: { ...goal.pause, reason: redactSecretsCached(goal.pause.reason) } } : {}),
  };
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, sessionId, goal: safeGoal }), { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
