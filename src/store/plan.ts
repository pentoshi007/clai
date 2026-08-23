import {
  mkdir,
  appendFile,
  readFile,
  writeFile,
  rename,
  rm,
  chown,
  stat,
} from "node:fs/promises";
import { fixOwner, fixOwnerSync, handlePermissionError, safeExists } from "../os/permissions.js";

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig } from "./config.js";
import { getPlanDir } from "./paths.js";
import { evaluateTaskTransition } from "./task-transitions.js";
import {
  applyPlanOperation,
  validatePlanDag,
  type PlanOperation,
  type VersionedPlanStep,
  type VersionedTaskPlan,
} from "../agent/task-plan.js";

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

const planDir = getPlanDir();
const jsonlFile =
  process.env.CLAI_PLAN_FILE ??
  (process.env.CLAI_PLAN_DIR || process.env.CLAI_DATA_DIR
    ? join(planDir, "plans.jsonl")
    : process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-plans-${process.env.VITEST_WORKER_ID}.jsonl`)
    : join(planDir, "plans.jsonl"));
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

function serializeTasksPayload(plan: SessionPlan): string {
  return JSON.stringify({
    schemaVersion: 2,
    version: plan.version,
    tasks: plan.tasks,
    ...(plan.meta && Object.keys(plan.meta).length > 0 ? { meta: plan.meta } : {}),
  });
}

function deserializeTasksPayload(raw: string): {
  tasks: PlanTask[];
  meta?: PlanMeta | undefined;
  version: number;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { tasks: parsed as PlanTask[], version: 1 };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { tasks?: unknown }).tasks)
    ) {
      const obj = parsed as { tasks: PlanTask[]; meta?: PlanMeta; version?: number };
      return {
        tasks: obj.tasks,
        meta: obj.meta,
        version: typeof obj.version === "number" && obj.version >= 1 ? obj.version : 1,
      };
    }
  } catch {
    /* ignore */
  }
  return { tasks: [], version: 1 };
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

function newTaskId(index: number): string {
  return `t${index + 1}`;
}

/** True when a title is only a bare checklist id (t1, t2, …), not real work. */
export function isBareTaskIdTitle(title: string): boolean {
  return /^t\d+$/i.test(title.trim());
}

/**
 * Drop phantom tasks whose title is just `t1`/`t2`/… (models sometimes
 * interleave bare ids with real titles). Keeps real task ids stable so
 * in-flight task.update calls still resolve.
 */
export function stripBareTaskIdTasks(tasks: PlanTask[]): PlanTask[] {
  return tasks.filter((t) => t.title.trim() && !isBareTaskIdTitle(t.title));
}

export function tasksFromTitles(titles: string[]): PlanTask[] {
  return titles
    .map((title) => title.trim())
    .filter((title) => Boolean(title) && !isBareTaskIdTitle(title))
    .map((title, index) => ({
      id: newTaskId(index),
      title,
      state: "pending" as TaskState,
      dependencies: index > 0 ? [newTaskId(index - 1)] : [],
      resourceLocks: [],
    }));
}

/**
 * Heal dependency edges without inventing scheduling.
 *
 * Only genuinely broken edges are removed: self-references, ids that no longer
 * exist, and edges that would close a cycle. Valid forward references are kept
 * so an authored DAG keeps its parallelism. `dependencies: []` is an explicit
 * statement of independence and is never replaced; only a legacy row with no
 * dependency field at all falls back to the previous foreground task, and a
 * responder child never becomes a blocker.
 *
 * Returns true when any task's dependencies changed.
 */
export function normalizeTaskDependencies(tasks: PlanTask[]): boolean {
  let changed = false;
  const known = new Set(tasks.map((task) => task.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const wouldCycle = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === from) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (byId.get(id)?.dependencies ?? []).some(walk);
    };
    return walk(to);
  };

  for (const [index, task] of tasks.entries()) {
    const declared = task.dependencies;
    const cleaned: string[] = [];
    for (const dependency of declared ?? []) {
      if (dependency === task.id || !known.has(dependency)) continue;
      if (cleaned.includes(dependency)) continue;
      if (wouldCycle(task.id, dependency)) continue;
      cleaned.push(dependency);
    }
    let next = cleaned;
    if (declared === undefined && !task.responderOwned && cleaned.length === 0) {
      const previousForeground = tasks
        .slice(0, index)
        .reverse()
        .find((candidate) => !candidate.responderOwned);
      if (previousForeground && !wouldCycle(task.id, previousForeground.id)) {
        next = [previousForeground.id];
      }
    }
    const previous = declared ?? [];
    if (
      declared === undefined ||
      previous.length !== next.length ||
      previous.some((id, position) => id !== next[position])
    ) {
      task.dependencies = next;
      changed = true;
    }
  }
  return changed;
}

/** Plan header goal: keep it a short title, never a full paragraph. */
const PLAN_GOAL_MAX_CHARS = 80;
/** Hard ceiling — beyond this even a clause-boundary cut still applies. */
const PLAN_GOAL_HARD_CHARS = 140;

/**
 * Collapse whitespace and shorten an overlong plan goal to a title.
 * Models sometimes echo the user's full multi-clause request as the goal.
 * Prefer cutting at a natural boundary (sentence end, then comma/paren/dash)
 * so the result still reads as a sensible phrase — never a mid-word or
 * mid-clause fragment with a dangling ellipsis.
 */
export function shortenPlanGoal(raw: string): string {
  const goal = raw.replace(/\s+/g, " ").trim();
  if (!goal || goal.length <= PLAN_GOAL_MAX_CHARS) return goal;

  // 1) First full sentence, if it's already a reasonable title length.
  const firstSentence = goal.match(/^.+?[.!?](?:\s|$)/);
  if (firstSentence) {
    const candidate = firstSentence[0].trim();
    if (candidate.length >= 12 && candidate.length <= PLAN_GOAL_HARD_CHARS) {
      return candidate;
    }
  }

  // 2) Cut at the last clause boundary (, ; : ( — –) at or before the max
  // length, so we keep as much of the meaningful phrase as fits — not the
  // first comma we see (which can land after just 2-3 words).
  const window = goal.slice(0, PLAN_GOAL_MAX_CHARS);
  const boundaryRe = /[,;:]|\s[-–—(]/g;
  let lastBoundaryEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = boundaryRe.exec(window)) !== null) {
    lastBoundaryEnd = m.index;
  }
  if (lastBoundaryEnd >= 24) {
    const candidate = window.slice(0, lastBoundaryEnd).trim();
    if (candidate.length >= 24) return candidate;
  }

  // 3) No good boundary within range — leave it as-is rather than risk a
  // mangled, meaningless fragment. Only hard-cut if truly excessive.
  if (goal.length <= PLAN_GOAL_HARD_CHARS) return goal;
  let cut = goal.slice(0, PLAN_GOAL_HARD_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(PLAN_GOAL_HARD_CHARS * 0.5)) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}

export function createPlan(input: {
  sessionId: string;
  goal: string;
  detail: string;
  taskTitles: string[];
  kind?: string | undefined;
  meta?: PlanMeta | undefined;
}): SessionPlan {
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    schemaVersion: 2,
    version: 1,
    sessionId: input.sessionId,
    goal: shortenPlanGoal(input.goal) || "Untitled plan",
    detail: input.detail.trim(),
    tasks: tasksFromTitles(input.taskTitles),
    status: "draft",
    kind: input.kind?.trim() || "general",
    createdAt: now,
    updatedAt: now,
  };
  if (input.meta && Object.keys(input.meta).length > 0) {
    plan.meta = input.meta;
  }
  return plan;
}

export function patchPlanMeta(
  plan: SessionPlan,
  patch: PlanMeta,
): SessionPlan {
  plan.meta = { ...(plan.meta ?? {}), ...patch };
  return plan;
}

/**
 * Every plan write is serialized in-process.
 *
 * The JSONL backend rewrites the whole file (read → modify → write) and the
 * SQLite backend used an unconditional UPSERT, so two concurrent writers (a
 * foreground task transition and an asynchronous responder settlement) could
 * each save their own `v+1` derived from the same base version. The later write
 * silently reverted the earlier one — reopening completed parents or re-yellowing
 * settled children.
 */
let planWriteQueue: Promise<unknown> = Promise.resolve();

let planWriteDepth = 0;

function enqueuePlanWrite<T>(task: () => Promise<T>): Promise<T> {
  // Re-entrancy: a queued mutation may load a plan that heals itself through
  // savePlan. Waiting on the queue from inside the queue would deadlock.
  if (planWriteDepth > 0) return task();
  const tracked = async (): Promise<T> => {
    planWriteDepth += 1;
    try {
      return await task();
    } finally {
      planWriteDepth -= 1;
    }
  };
  const run = planWriteQueue.then(tracked, tracked);
  // Keep the chain alive regardless of individual failures.
  planWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const jsonlLockDir = `${jsonlFile}.lock`;
const JSONL_LOCK_STALE_MS = 10_000;

/** Cross-process advisory lock for the JSONL fallback (atomic mkdir). */
async function withJsonlLock<T>(task: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  try {
    await mkdir(dirname(jsonlFile), { recursive: true });
  } catch {
    // Directory creation is retried by appendJsonl.
  }
  for (;;) {
    try {
      await mkdir(jsonlLockDir);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Break a stale lock left behind by a crashed process.
      try {
        const info = await stat(jsonlLockDir);
        if (Date.now() - info.mtimeMs > JSONL_LOCK_STALE_MS) {
          await rm(jsonlLockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring plan store lock: ${jsonlLockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await task();
  } finally {
    await rm(jsonlLockDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Persist unconditionally (no version check). Used for whole-plan replacement
 * (creation, approval of a freshly built plan, migrations). Concurrent
 * transitions must use {@link mutatePlan} instead.
 */
export async function savePlan(plan: SessionPlan): Promise<void> {
  plan.updatedAt = new Date().toISOString();
  if (getConfig().privateMode) return; // never persist in private mode
  await enqueuePlanWrite(async () => {
    const db = await loadDatabase();
    if (db) {
      writePlanRowSqlite(db, plan);
      return;
    }
    await withJsonlLock(() => appendJsonl(plan));
  });
}

function writePlanRowSqlite(db: DatabaseLike, plan: SessionPlan): void {
  db.prepare(
    `INSERT INTO plans (session_id, goal, detail, tasks_json, status, kind, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         goal=excluded.goal, detail=excluded.detail, tasks_json=excluded.tasks_json,
         status=excluded.status, kind=excluded.kind, updated_at=excluded.updated_at,
         version=excluded.version`,
  ).run(
    plan.sessionId,
    plan.goal,
    plan.detail,
    serializeTasksPayload(plan),
    plan.status,
    plan.kind,
    plan.createdAt,
    plan.updatedAt,
    plan.version ?? 1,
  );
}

/** Compare-and-set write: only replaces a row still at `expectedVersion`. */
function casPlanRowSqlite(
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

export interface PlanMutationResult {
  ok: boolean;
  /** Persisted plan after the reducer ran. */
  plan?: SessionPlan | undefined;
  /** Why the mutation did not apply. */
  reason?:
    | "missing-plan"
    | "version-conflict"
    | "no-change"
    | "invalid"
    | "persist-failed"
    | "private-mode"
    | undefined;
  /** Invariant repairs applied while committing. */
  repairs?: string[] | undefined;
}

const PLAN_MUTATION_RETRIES = 5;

/**
 * The authoritative plan mutation boundary.
 *
 * Loads the plan fresh, runs `reducer` on it, enforces domain invariants, then
 * persists with a version compare-and-set. On a CAS conflict the reducer is
 * re-run against the newer state (reducers must therefore be idempotent and
 * expressed as "apply this transition", not "write this snapshot").
 *
 * Return `false` from the reducer to abort without writing.
 */
export async function mutatePlan(
  sessionId: string,
  reducer: (draft: SessionPlan) => boolean | void,
  opts?: { expectedVersion?: number | undefined; retries?: number | undefined },
): Promise<PlanMutationResult> {
  if (getConfig().privateMode) {
    // Nothing is persisted in private mode; apply to a transient copy so
    // callers still see a consistent in-memory result.
    const plan = await loadPlan(sessionId);
    if (!plan) return { ok: false, reason: "missing-plan" };
    if (reducer(plan) === false) return { ok: false, reason: "no-change" };
    const repairs = enforcePlanInvariants(plan);
    plan.version = (plan.version ?? 1) + 1;
    plan.updatedAt = new Date().toISOString();
    return { ok: true, plan, ...(repairs.length ? { repairs } : {}) };
  }

  const retries = opts?.retries ?? PLAN_MUTATION_RETRIES;
  return enqueuePlanWrite(async () => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const current = await loadPlan(sessionId);
      if (!current) return { ok: false, reason: "missing-plan" as const };
      const baseVersion = current.version ?? 1;
      if (
        opts?.expectedVersion !== undefined &&
        opts.expectedVersion !== baseVersion
      ) {
        return { ok: false, reason: "version-conflict" as const };
      }
      const draft = clonePlan(current);
      if (reducer(draft) === false) {
        return { ok: false, reason: "no-change" as const, plan: current };
      }
      const repairs = enforcePlanInvariants(draft);
      const validation = validateSessionPlan(draft);
      if (!validation.ok) {
        return { ok: false, reason: "invalid" as const, plan: current };
      }
      draft.version = baseVersion + 1;
      draft.updatedAt = new Date().toISOString();

      const db = await loadDatabase();
      if (db) {
        if (casPlanRowSqlite(db, draft, baseVersion)) {
          return {
            ok: true,
            plan: draft,
            ...(repairs.length ? { repairs } : {}),
          };
        }
        continue; // another writer won; re-run the reducer on fresh state
      }
      const committed = await withJsonlLock(async () => {
        const stored = (await readAllJsonl()).find(
          (candidate) => candidate.sessionId === sessionId,
        );
        if ((stored?.version ?? 1) !== baseVersion) return false;
        await appendJsonl(draft);
        return true;
      });
      if (committed) {
        return { ok: true, plan: draft, ...(repairs.length ? { repairs } : {}) };
      }
    }
    return { ok: false, reason: "version-conflict" as const };
  });
}

function clonePlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      dependencies: [...(task.dependencies ?? [])],
      resourceLocks: [...(task.resourceLocks ?? [])],
      ...(task.evidence ? { evidence: { ...task.evidence } } : {}),
      ...(task.aliases ? { aliases: [...task.aliases] } : {}),
    })),
    ...(plan.meta ? { meta: { ...plan.meta } } : {}),
  };
}

async function writeJsonlAtomic(plans: readonly SessionPlan[]): Promise<void> {
  await mkdir(planDir, { recursive: true });
  await fixOwner(planDir);
  const body = plans.map((p) => JSON.stringify(p)).join("\n");
  const tmp = `${jsonlFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, body ? `${body}\n` : "", { mode: 0o600 });
  await rename(tmp, jsonlFile);
  await fixOwner(jsonlFile);
}

async function appendJsonl(plan: SessionPlan): Promise<void> {
  try {
    const existing = await readAllJsonl();
    const map = new Map(existing.map((p) => [p.sessionId, p]));
    map.set(plan.sessionId, plan);
    await writeJsonlAtomic([...map.values()]);
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
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionPlan];
        } catch {
          return [];
        }
      });
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}

/** Upgrade legacy persisted plans without changing task ids or states. */
/**
 * Fill in dependencies for legacy rows that never stored the field. The previous
 * foreground task is the default; a responder child is display-linked to its
 * parent and must never become a blocker.
 */
function normalizeLegacyDependencies(tasks: readonly PlanTask[]): PlanTask[] {
  return tasks.map((task, index) => {
    const previousForeground = tasks
      .slice(0, index)
      .reverse()
      .find((candidate) => !candidate.responderOwned);
    const legacyDefault =
      task.responderOwned || !previousForeground ? [] : [previousForeground.id];
    return {
      ...task,
      dependencies: [...(task.dependencies ?? legacyDefault)],
      resourceLocks: [...(task.resourceLocks ?? [])],
    };
  });
}

function normalizePersistedPlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    schemaVersion: 2,
    version:
      typeof plan.version === "number" && plan.version >= 1
        ? plan.version
        : 1,
    tasks: normalizeLegacyDependencies(plan.tasks),
  };
}

/** Heal plans that stored bare `t1`/`t2` strings as task titles. */
function healBareIdTasks(plan: SessionPlan): {
  plan: SessionPlan;
  healed: boolean;
} {
  const cleaned = stripBareTaskIdTasks(plan.tasks);
  if (cleaned.length === plan.tasks.length) return { plan, healed: false };
  return { plan: { ...plan, tasks: cleaned }, healed: true };
}

export async function loadPlan(sessionId: string): Promise<SessionPlan | undefined> {
  const db = await loadDatabase();
  if (db) {
    const row = db
      .prepare(
        "SELECT session_id, goal, detail, tasks_json, status, kind, created_at, updated_at, version FROM plans WHERE session_id = ?",
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
          version?: number | null;
        }
      | undefined;
    if (!row) return undefined;
    const { tasks, meta, version } = deserializeTasksPayload(row.tasks_json);
    // The column is authoritative once present (CAS writes maintain it).
    const rowVersion =
      typeof row.version === "number" && row.version >= 1
        ? Math.max(row.version, version)
        : version;
    const plan: SessionPlan = {
      schemaVersion: 2,
      version: rowVersion,
      sessionId: row.session_id,
      goal: row.goal,
      detail: row.detail,
      tasks,
      status: row.status as PlanStatus,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (meta) plan.meta = meta;
    const needsNormalization = plan.tasks.some(
      (task) => task.dependencies === undefined || task.resourceLocks === undefined,
    );
    const normalized = normalizePersistedPlan(plan);
    const { plan: healed, healed: dirty } = healBareIdTasks(normalized);
    const repairs = enforcePlanInvariants(healed);
    if (dirty || needsNormalization || repairs.length > 0) {
      // Persist upgrades so resumed SQLite and JSONL plans share dependency semantics.
      await savePlan(healed);
    }
    return healed;
  }
  const found = (await readAllJsonl()).find((p) => p.sessionId === sessionId);
  if (!found) return undefined;
  const needsNormalization = found.tasks.some(
    (task) => task.dependencies === undefined || task.resourceLocks === undefined,
  );
  const normalized = normalizePersistedPlan(found);
  const { plan: healed, healed: dirty } = healBareIdTasks(normalized);
  const repairs = enforcePlanInvariants(healed);
  if (dirty || needsNormalization || repairs.length > 0) await savePlan(healed);
  return healed;
}

export async function deletePlan(sessionId: string): Promise<void> {
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM plans WHERE session_id = ?").run(sessionId);
      return;
    }
    await withJsonlLock(async () => {
      const existing = await readAllJsonl();
      const remaining = existing.filter((p) => p.sessionId !== sessionId);
      if (remaining.length === existing.length) return;
      await writeJsonlAtomic(remaining);
    });
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

// Task mutations

const toDomainStatus = (state: TaskState): VersionedPlanStep["status"] =>
  state === "in_progress" ? "running" : state;
const fromDomainStatus = (state: VersionedPlanStep["status"]): TaskState =>
  state === "running" ? "in_progress" : state;

function toVersionedTaskPlan(plan: SessionPlan): VersionedTaskPlan {
  return {
    schemaVersion: 2,
    version: plan.version ?? 1,
    id: plan.sessionId,
    goal: plan.goal,
    complexity: "standard",
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      kind: "other",
      status: toDomainStatus(task.state),
      notes: task.note,
      dependencies: [...(task.dependencies ?? [])],
      resourceLocks: [...(task.resourceLocks ?? [])],
      supersededBy: task.supersededBy,
      parentTaskId: task.parentTaskId,
      jobId: task.jobId,
      processId: task.processId,
      responderOwned: task.responderOwned,
    })),
  };
}

export function applySessionPlanOperation(
  plan: SessionPlan,
  operation: PlanOperation,
): SessionPlan {
  const updated = applyPlanOperation(toVersionedTaskPlan(plan), operation);
  const prior = new Map(plan.tasks.map((task) => [task.id, task]));
  return {
    ...plan,
    version: updated.version,
    updatedAt: updated.updatedAt,
    tasks: updated.steps.map((step) => ({
      id: step.id,
      title: step.title,
      state: fromDomainStatus(step.status),
      note: step.notes,
      evidence: prior.get(step.id)?.evidence,
      aliases: prior.get(step.id)?.aliases,
      dependencies: [...(step.dependencies ?? [])],
      resourceLocks: [...(step.resourceLocks ?? [])],
      supersededBy: step.supersededBy,
      parentTaskId: step.parentTaskId,
      jobId: step.jobId,
      processId: step.processId,
      responderOwned: step.responderOwned,
    })),
  };
}

export function validateSessionPlan(plan: SessionPlan): { ok: true } | { ok: false; reason: string } {
  return validatePlanDag(toVersionedTaskPlan(plan));
}

export function nextPlanTaskId(tasks: readonly Pick<PlanTask, "id">[]): string {
  let max = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/i.exec(task.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `t${max + 1}`;
  const used = new Set(tasks.map((task) => task.id));
  while (used.has(candidate)) candidate = `t${++max + 1}`;
  return candidate;
}

export function appendPlanTask(
  plan: SessionPlan,
  input: Omit<PlanTask, "id"> & { id?: string | undefined },
): PlanTask {
  const task: PlanTask = {
    ...input,
    id: input.id ?? nextPlanTaskId(plan.tasks),
    dependencies: [...(input.dependencies ?? [])],
    resourceLocks: [...(input.resourceLocks ?? [])],
  };
  if (plan.tasks.some((candidate) => candidate.id === task.id)) {
    throw new Error(`duplicate task id: ${task.id}`);
  }
  if (
    task.parentTaskId &&
    !plan.tasks.some((candidate) => candidate.id === task.parentTaskId)
  ) {
    throw new Error(`unknown parent task: ${task.parentTaskId}`);
  }
  let index = plan.tasks.length;
  if (task.parentTaskId) {
    const parentIndex = plan.tasks.findIndex(
      (candidate) => candidate.id === task.parentTaskId,
    );
    index = parentIndex + 1;
    while (
      index < plan.tasks.length &&
      plan.tasks[index]?.parentTaskId === task.parentTaskId
    ) {
      index += 1;
    }
  }
  plan.tasks.splice(index, 0, task);
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  if (plan.status === "completed" || plan.status === "abandoned") {
    plan.status = "in_progress";
  }
  return task;
}

export function readyPlanTasks(plan: SessionPlan): PlanTask[] {
  const done = new Set(
    plan.tasks
      .filter((task) => task.state === "done" || task.state === "skipped")
      .map((task) => task.id),
  );
  const held = new Set(
    plan.tasks
      .filter((task) => task.state === "in_progress" && !task.responderOwned)
      .flatMap((task) => task.resourceLocks ?? []),
  );
  return plan.tasks.filter(
    (task) =>
      task.state === "pending" &&
      !task.responderOwned &&
      !task.supersededBy &&
      (task.dependencies ?? []).every((dependency) => done.has(dependency)) &&
      !(task.resourceLocks ?? []).some((resource) => held.has(resource)),
  );
}

/** Foreground (non-responder) tasks that are currently `in_progress`. */
export function activeForegroundTasks(plan: SessionPlan): PlanTask[] {
  return plan.tasks.filter(
    (task) => !task.responderOwned && task.state === "in_progress",
  );
}

/**
 * `count(foreground tasks in_progress) <= 1` is a domain invariant,
 * not a prompt convention. Applied on every {@link mutatePlan} commit and on
 * load. The earliest dependency-valid active task is kept; later ones are
 * demoted to `pending` with a repair note (evidence is preserved).
 *
 * A parent/child display relationship never implies a dependency, so responder
 * children may run concurrently and are ignored here.
 */
export function enforcePlanInvariants(plan: SessionPlan): string[] {
  const repairs: string[] = [...repairOrphanParents(plan)];
  const active = activeForegroundTasks(plan);
  if (active.length <= 1) return repairs;

  const settled = new Set(
    plan.tasks
      .filter((task) => task.state === "done" || task.state === "skipped")
      .map((task) => task.id),
  );
  const dependencyValid = (task: PlanTask): boolean =>
    (task.dependencies ?? []).every((dependency) => settled.has(dependency));

  const keep = active.find(dependencyValid) ?? active[0]!;
  for (const task of active) {
    if (task === keep) continue;
    task.state = "pending";
    task.note = task.note
      ? `${task.note} (reopened later: only one foreground task may be active)`
      : "Demoted to pending: only one foreground task may be active at a time.";
    repairs.push(`demoted ${task.id} to pending (single-active invariant)`);
  }
  return repairs;
}

/**
 * Never leave a child pointing at a task that no longer exists. A revision that
 * removes a parent with live children keeps the ownership audit in the note and
 * detaches the display link instead of silently orphaning the row.
 */
function repairOrphanParents(plan: SessionPlan): string[] {
  const repairs: string[] = [];
  const known = new Set(plan.tasks.map((task) => task.id));
  for (const task of plan.tasks) {
    if (!task.parentTaskId || known.has(task.parentTaskId)) continue;
    const detached = task.parentTaskId;
    delete task.parentTaskId;
    task.note = task.note
      ? `${task.note} (detached: parent ${detached} was removed)`
      : `Detached responder work: parent ${detached} was removed by a revision.`;
    repairs.push(`detached ${task.id} from removed parent ${detached}`);
  }
  return repairs;
}

/**
 * Apply a foreground-authored plan snapshot onto fresh state.
 *
 * Whole-plan writes (plan.create, revisions, task.add reordering) are authored
 * against a loaded copy. Replacing the stored plan with that copy dropped
 * anything an asynchronous writer changed in the meantime. This applies the
 * snapshot's foreground intent while treating responder children as owned by
 * process settlement:
 *
 * - responder-owned rows keep their stored state/note/job linkage;
 * - responder children created concurrently are retained;
 * - stored evidence is kept when the snapshot has none for that task.
 */
export function applyForegroundSnapshot(
  draft: SessionPlan,
  snapshot: SessionPlan,
): void {
  const stored = new Map(draft.tasks.map((task) => [task.id, task]));
  const next: PlanTask[] = [];
  for (const task of snapshot.tasks) {
    const existing = stored.get(task.id);
    if (existing?.responderOwned) {
      next.push(existing);
      continue;
    }
    next.push({
      ...task,
      ...(task.evidence === undefined && existing?.evidence
        ? { evidence: existing.evidence }
        : {}),
    });
  }
  const kept = new Set(next.map((task) => task.id));
  for (const task of draft.tasks) {
    if (kept.has(task.id)) continue;
    // Only responder children may appear from a concurrent writer; a foreground
    // task missing from the snapshot was intentionally removed by the author.
    if (!task.responderOwned) continue;
    const parentIndex = task.parentTaskId
      ? next.findIndex((candidate) => candidate.id === task.parentTaskId)
      : -1;
    if (parentIndex >= 0) next.splice(parentIndex + 1, 0, task);
    else next.push(task);
  }
  draft.tasks = next;
  draft.goal = snapshot.goal;
  draft.detail = snapshot.detail;
  draft.status = snapshot.status;
  draft.kind = snapshot.kind;
  if (snapshot.meta) draft.meta = { ...(draft.meta ?? {}), ...snapshot.meta };
}

/**
 * Apply a task transition. Rejects transitions the  table forbids so no
 * caller can rewind terminal work; use a plan revision to supersede a task.
 */
export function markTask(
  plan: SessionPlan,
  taskId: string,
  state: TaskState,
  note?: string | undefined,
): boolean {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  if (!evaluateTaskTransition(task.state, state).allowed) return false;
  task.state = state;
  if (note !== undefined) task.note = note;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return true;
}

/** Mark the first not-yet-finished foreground task as the given state. */
export function markNextTask(plan: SessionPlan, state: TaskState): PlanTask | undefined {
  const task = plan.tasks.find(
    (candidate) =>
      !candidate.responderOwned &&
      (candidate.state === "pending" || candidate.state === "in_progress"),
  );
  if (!task) return undefined;
  task.state = state;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return task;
}

/** Tasks the model owns. Responder children advance from process lifecycle. */
export function foregroundTasks(plan: SessionPlan): PlanTask[] {
  return plan.tasks.filter((task) => !task.responderOwned);
}

/** Foreground work that is neither settled nor skipped, in plan order. */
export function foregroundRemaining(plan: SessionPlan): PlanTask[] {
  return foregroundTasks(plan).filter(
    (task) => task.state === "pending" || task.state === "in_progress",
  );
}

/** The single active foreground task, or the next one to resume. */
export function foregroundActiveTask(plan: SessionPlan): PlanTask | undefined {
  const remaining = foregroundRemaining(plan);
  return (
    remaining.find((task) => task.state === "in_progress") ?? remaining[0]
  );
}

/** Responder children that are still running or awaiting analysis. */
export function responderOpenTasks(plan: SessionPlan): PlanTask[] {
  return plan.tasks.filter(
    (task) =>
      task.responderOwned &&
      (task.state === "pending" || task.state === "in_progress"),
  );
}

export function planProgress(plan: SessionPlan): { done: number; total: number } {
  const foreground = foregroundTasks(plan);
  const done = foreground.filter((task) => task.state === "done").length;
  return { done, total: foreground.length };
}

export function isPlanTerminal(plan: SessionPlan): boolean {
  const foreground = foregroundTasks(plan);
  return (
    foreground.length > 0 &&
    foreground.every(
      (task) =>
        task.state === "done" ||
        task.state === "skipped" ||
        task.state === "failed",
    )
  );
}

export function isPlanSuccessful(plan: SessionPlan): boolean {
  const foreground = foregroundTasks(plan);
  return (
    foreground.length > 0 &&
    foreground.every(
      (task) => task.state === "done" || task.state === "skipped",
    )
  );
}

/** @deprecated Use isPlanTerminal or isPlanSuccessful explicitly. */
export function isPlanComplete(plan: SessionPlan): boolean {
  return isPlanSuccessful(plan);
}
