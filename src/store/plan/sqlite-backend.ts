import { fixOwner, fixOwnerSync, handlePermissionError } from "../../os/permissions.js";
import { getPlanDir } from "../paths.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const planDir = getPlanDir();

const dbFile = join(planDir, "history.db");

const sqliteModuleName = "better-sqlite3";

export type TaskState = "pending" | "in_progress" | "done" | "failed" | "skipped";

export type PlanStatus = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

export interface TaskEvidence {
  successWorkCount: number;
  lastOkTool?: string | undefined;
  sawSourceWrite?: boolean | undefined;
  sawFeatureWrite?: boolean | undefined;
  sawInstallOk?: boolean | undefined;
  sawScaffoldOk?: boolean | undefined;
  sawDevServerStart?: boolean | undefined;
  sawLocalHttpProbeOk?: boolean | undefined;
  sawServerReady?: boolean | undefined;
  sawPortListening?: boolean | undefined;
  sawRemoteReconOk?: boolean | undefined;
  sawRemoteActiveTestOk?: boolean | undefined;
}

export interface PlanTask {
  id: string;
  title: string;
  state: TaskState;
  note?: string | undefined;
  acceptanceCriteria?: string | undefined;
  evidence?: TaskEvidence | undefined;
  aliases?: string[] | undefined;
  dependencies?: string[] | undefined;
  resourceLocks?: string[] | undefined;
  supersededBy?: string | undefined;
  parentTaskId?: string | undefined;
  jobId?: string | undefined;
  processId?: number | undefined;
  responderOwned?: boolean | undefined;
  delegationId?: string | undefined;
  settledResultRevision?: number | undefined;
}

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
    try {
      cachedDb.exec("ALTER TABLE plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1;");
    } catch {
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
