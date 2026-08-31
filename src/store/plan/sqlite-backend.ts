import { fixOwner, fixOwnerSync, handlePermissionError } from "../../os/permissions.js";
import { getPlanDir } from "../paths.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const planDir = getPlanDir();

const dbFile = join(planDir, "history.db");

const sqliteModuleName = "better-sqlite3";

export type TaskState = "pending" | "in_progress" | "done" | "failed" | "skipped";

export type PlanStatus = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

/** Durable, task-scoped facts from successful work. These survive compaction and resume. */
export interface TaskEvidence {
  successWorkCount: number;
  lastOkTool?: string | undefined;
  sawSourceWrite?: boolean | undefined;
  sawFeatureWrite?: boolean | undefined;
  sawInstallOk?: boolean | undefined;
  sawScaffoldOk?: boolean | undefined;
  /** Local app: shell.start / npm run dev. */
  sawDevServerStart?: boolean | undefined;
  /** Local app: successful localhost HTTP probe. */
  sawLocalHttpProbeOk?: boolean | undefined;
  /** Local app: job log shows ready + URL (Vite/Next/etc.). */
  sawServerReady?: boolean | undefined;
  /** Local app: port LISTEN evidence (lsof/ss). */
  sawPortListening?: boolean | undefined;
  /** Pentest: successful remote recon tool against a target. */
  sawRemoteReconOk?: boolean | undefined;
  /** Pentest: active test / exploit-style tool against a target. */
  sawRemoteActiveTestOk?: boolean | undefined;
}

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
  note?: string | undefined;
  /** Evidence condition that must hold before this task can be considered complete. */
  acceptanceCriteria?: string | undefined;
  /** Successful task-scoped evidence, persisted with the plan for resume safety. */
  evidence?: TaskEvidence | undefined;
  /** Model-supplied slugs (id/name) that resolve to this task via task.update. */
  aliases?: string[] | undefined;
  dependencies?: string[] | undefined;
  resourceLocks?: string[] | undefined;
  supersededBy?: string | undefined;
  /** Display hierarchy only; dependency order remains explicit in dependencies. */
  parentTaskId?: string | undefined;
  /** Durable background process linked to this task. */
  jobId?: string | undefined;
  processId?: number | undefined;
  /** Responder-owned tasks advance from job lifecycle events, not task.update. */
  responderOwned?: boolean | undefined;
  /**
   * Stable delegation identity created *before* the process launches,
   * so a fast-exiting job can always be reconciled to its child task even if
   * linking or the plan save lost a race.
   */
  delegationId?: string | undefined;
  /** Authoritative result revision this responder child was settled from. */
  settledResultRevision?: number | undefined;
}

/** Durable side-channel facts that survive compaction/resume. */
export interface PlanMeta {
  projectRoot?: string | undefined;
  packageManager?: string | undefined;
  devCommand?: string | undefined;
}

export interface SessionPlan {
  schemaVersion?: 2 | undefined;
  version?: number | undefined;
  sessionId: string;
  goal: string;
  detail: string;
  tasks: PlanTask[];
  status: PlanStatus;
  kind: string;
  createdAt: string;
  updatedAt: string;
  meta?: PlanMeta | undefined;
}

export function serializeTasksPayload(plan: SessionPlan): string {
  return JSON.stringify({
    schemaVersion: 2,
    version: plan.version,
    tasks: plan.tasks,
    ...(plan.meta && Object.keys(plan.meta).length > 0 ? { meta: plan.meta } : {}),
  });
}

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

type DatabaseCtor = new (path: string) => DatabaseLike;

let cachedDb: DatabaseLike | undefined;

let sqliteUnavailable = false;

export async function loadDatabase(): Promise<DatabaseLike | undefined> {
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
    // A real version column so writes can compare-and-set. Legacy
    // rows default to 1 and are corrected on the first successful mutation.
    try {
      cachedDb.exec("ALTER TABLE plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1;");
    } catch {
      // Column already exists.
    }
    return cachedDb;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    sqliteUnavailable = true;
    return undefined;
  }
}

/** Compare-and-set write: only replaces a row still at `expectedVersion`. */
export function casPlanRowSqlite(
  db: DatabaseLike,
  plan: SessionPlan,
  expectedVersion: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE plans SET goal=?, detail=?, tasks_json=?, status=?, kind=?, updated_at=?, version=?
         WHERE session_id=? AND version=?`,
    )
    .run(
      plan.goal,
      plan.detail,
      serializeTasksPayload(plan),
      plan.status,
      plan.kind,
      plan.updatedAt,
      plan.version ?? expectedVersion + 1,
      plan.sessionId,
      expectedVersion,
    ) as { changes?: number } | undefined;
  return (info?.changes ?? 0) > 0;
}
