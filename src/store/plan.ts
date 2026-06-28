import { mkdir, appendFile, readFile, writeFile, rm, chown } from "node:fs/promises";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";

import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getConfig } from "./config.js";

/**
 * Session-scoped plan + task persistence.
 *
 * A plan is a comprehensive, human-readable description of HOW the agent
 * intends to accomplish a multi-step goal (coding OR pentesting), paired
 * with an ordered checklist of tasks. The agent has the plan in context for
 * the whole session, marks tasks done as it completes them, and the user can
 * view it in a pager (Ctrl+P) or approve execution with /implement.
 *
 * Storage mirrors history.ts: SQLite when better-sqlite3 is available,
 * otherwise an always-present JSONL log. Plans are keyed by a session id so
 * each REPL session keeps its own plan, and resuming a session reloads it.
 */

const planDir = join(homedir(), ".clai");
const jsonlFile =
  process.env.CLAI_PLAN_FILE ??
  (process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-plans-${process.env.VITEST_WORKER_ID}.jsonl`)
    : join(planDir, "plans.jsonl"));
const dbFile = join(planDir, "history.db");
const sqliteModuleName = "better-sqlite3";

export type TaskState = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type PlanStatus = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
  note?: string | undefined;
}

export interface SessionPlan {
  /** Session id this plan belongs to (one active plan per session). */
  sessionId: string;
  /** Short title for the overall goal. */
  goal: string;
  /** Free-form, comprehensive plan body (markdown). Shown in the pager. */
  detail: string;
  /** Ordered checklist. */
  tasks: PlanTask[];
  status: PlanStatus;
  /** "coding" | "pentest" | "general" — informational, set by the agent. */
  kind: string;
  createdAt: string;
  updatedAt: string;
}

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
type DatabaseCtor = new (path: string) => DatabaseLike;

let cachedDb: DatabaseLike | undefined;
let sqliteUnavailable = false;

async function loadDatabase(): Promise<DatabaseLike | undefined> {
  // Tests and JSONL-fallback installs skip SQLite entirely.
  if (process.env.CLAI_PLAN_FILE || process.env.VITEST_WORKER_ID) return undefined;
  if (cachedDb) return cachedDb;
  if (sqliteUnavailable) return undefined;
  try {
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    const imported = (await import(sqliteModuleName)) as {
      default?: DatabaseCtor;
    } & DatabaseCtor;
    const Ctor = imported.default ?? imported;
    cachedDb = new Ctor(dbFile);
    fixOwnerSync(dbFile);
    cachedDb.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        session_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        detail TEXT NOT NULL,
        tasks_json TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

function newTaskId(index: number): string {
  return `t${index + 1}`;
}

export function tasksFromTitles(titles: string[]): PlanTask[] {
  return titles
    .map((title) => title.trim())
    .filter(Boolean)
    .map((title, index) => ({ id: newTaskId(index), title, state: "pending" as TaskState }));
}

export function createPlan(input: {
  sessionId: string;
  goal: string;
  detail: string;
  taskTitles: string[];
  kind?: string | undefined;
}): SessionPlan {
  const now = new Date().toISOString();
  return {
    sessionId: input.sessionId,
    goal: input.goal.trim() || "Untitled plan",
    detail: input.detail.trim(),
    tasks: tasksFromTitles(input.taskTitles),
    status: "draft",
    kind: input.kind?.trim() || "general",
    createdAt: now,
    updatedAt: now,
  };
}

export async function savePlan(plan: SessionPlan): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  if (getConfig().privateMode) return; // never persist in private mode
  const db = await loadDatabase();
  if (db) {
    db.prepare(
      `INSERT INTO plans (session_id, goal, detail, tasks_json, status, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         goal=excluded.goal, detail=excluded.detail, tasks_json=excluded.tasks_json,
         status=excluded.status, kind=excluded.kind, updated_at=excluded.updated_at`,
    ).run(
      plan.sessionId,
      plan.goal,
      plan.detail,
      JSON.stringify(plan.tasks),
      plan.status,
      plan.kind,
      plan.createdAt,
      plan.updatedAt,
    );
    return;
  }
  await appendJsonl(plan);
}

async function appendJsonl(plan: SessionPlan): Promise<void> {
  try {
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    // JSONL fallback keeps the latest record per session; we compact on write
    // so the file does not grow unbounded for a long-lived session.
    const existing = await readAllJsonl();
    const map = new Map(existing.map((p) => [p.sessionId, p]));
    map.set(plan.sessionId, plan);
    const body = [...map.values()].map((p) => JSON.stringify(p)).join("\n");
    await writeFile(jsonlFile, body ? `${body}\n` : "", { mode: 0o600 });
    await fixOwner(jsonlFile);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

async function readAllJsonl(): Promise<SessionPlan[]> {
  if (!(await safeExists(jsonlFile))) return [];
  try {
    const raw = await readFile(jsonlFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionPlan);
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}

export async function loadPlan(sessionId: string): Promise<SessionPlan | undefined> {
  const db = await loadDatabase();
  if (db) {
    const row = db
      .prepare(
        "SELECT session_id, goal, detail, tasks_json, status, kind, created_at, updated_at FROM plans WHERE session_id = ?",
      )
      .get(sessionId) as
      | {
          session_id: string;
          goal: string;
          detail: string;
          tasks_json: string;
          status: string;
          kind: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      goal: row.goal,
      detail: row.detail,
      tasks: JSON.parse(row.tasks_json) as PlanTask[],
      status: row.status as PlanStatus,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return (await readAllJsonl()).find((p) => p.sessionId === sessionId);
}

export async function deletePlan(sessionId: string): Promise<void> {
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM plans WHERE session_id = ?").run(sessionId);
      return;
    }
    const existing = await readAllJsonl();
    const remaining = existing.filter((p) => p.sessionId !== sessionId);
    if (remaining.length === existing.length) return;
    await mkdir(planDir, { recursive: true });
    await fixOwner(planDir);
    const body = remaining.map((p) => JSON.stringify(p)).join("\n");
    await writeFile(jsonlFile, body ? `${body}\n` : "", { mode: 0o600 });
    await fixOwner(jsonlFile);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAllPlans(): Promise<void> {
  const db = await loadDatabase();
  if (db) {
    try {
      db.exec("DELETE FROM plans;");
    } catch {
      /* ignore */
    }
  }
  if (await safeExists(jsonlFile)) {
    try {
      await rm(jsonlFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Task mutations ────────────────────────────────────────────────────────

export function markTask(
  plan: SessionPlan,
  taskId: string,
  state: TaskState,
  note?: string | undefined,
): boolean {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  task.state = state;
  if (note !== undefined) task.note = note;
  return true;
}

/** Mark the first not-yet-finished task as the given state. */
export function markNextTask(plan: SessionPlan, state: TaskState): PlanTask | undefined {
  const task = plan.tasks.find((t) => t.state === "pending" || t.state === "in_progress");
  if (!task) return undefined;
  task.state = state;
  return task;
}

export function planProgress(plan: SessionPlan): { done: number; total: number } {
  const done = plan.tasks.filter((t) => t.state === "done").length;
  return { done, total: plan.tasks.length };
}

export function isPlanComplete(plan: SessionPlan): boolean {
  return (
    plan.tasks.length > 0 &&
    plan.tasks.every(
      (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
    )
  );
}
