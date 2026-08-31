import { validatePlanDag } from "../../agent/task-plan.js";
import type { VersionedPlanStep, VersionedTaskPlan } from "../../agent/task-plan.js";
import { getConfig } from "../config.js";
import { appendJsonl, enqueuePlanWrite, readAllJsonl, withJsonlLock } from "./jsonl-backend.js";
import { casPlanRowSqlite, DatabaseLike, loadDatabase, PlanMeta, PlanStatus, PlanTask, serializeTasksPayload, SessionPlan, TaskState } from "./sqlite-backend.js";

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

const toDomainStatus = (state: TaskState): VersionedPlanStep["status"] =>
  state === "in_progress" ? "running" : state;

export function toVersionedTaskPlan(plan: SessionPlan): VersionedTaskPlan {
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

export function validateSessionPlan(plan: SessionPlan): { ok: true } | { ok: false; reason: string } {
  return validatePlanDag(toVersionedTaskPlan(plan));
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
