import type { PlanToolResult } from "../handle-plan-tool.js";
import { renderPlanForTerminal } from "../handle-plan-tool.js";
import { normalizeCodingPlanTasks } from "../handle-plan-tool.js";
import { appendPlanTask, applyForegroundSnapshot, applySessionPlanOperation, createPlan, deletePlan, isBareTaskIdTitle, isPlanSuccessful, isPlanTerminal, loadPlan, markTask, mutatePlan, normalizeTaskDependencies, readyPlanTasks, savePlan, validateSessionPlan } from "../../../store/plan.js";
import type { SessionPlan, TaskState } from "../../../store/plan.js";
import { evaluateTaskTransition } from "../../../store/task-transitions.js";
import type { ToolCall } from "../../../types.js";
import { renderPlanChecklist } from "../../../ui/plan-pane.js";
import type { LoopGuard } from "../../loop-guard.js";
import { getActiveProjectRoot } from "../../project-root.js";
import type { SessionPolicy } from "../../session-policy.js";
import { classifyTaskTitle } from "../../task-evidence.js";
import { buildDependencyReminder, dependencyToast } from "../../task-sync.js";
import { isLumpedSingleTask } from "../../tool-call-parser.js";
import { detectPackageManager } from "../../workspace-orient.js";
import chalk from "chalk";
import { looksLikeRunOnlyGoal, nextTaskId, normalizePlanDetail, normalizePlanGoal, normalizePlanKind, normalizePlanTaskEntries, normalizeTaskTitle, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "../normalization.js";

export async function handlePlanCreate(
  call: ToolCall,
  session: SessionPolicy,
  autoApprove: boolean,
): Promise<PlanToolResult> {
  void autoApprove;
    const goal = normalizePlanGoal(call.args);
    const detail = normalizePlanDetail(call.args);
    const kind = normalizePlanKind(call.args);
    const taskEntries = normalizePlanTaskEntries(call.args);
    const taskTitles = taskEntries.map((t) => t.title);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array. " +
          'Accepted task shapes: ["step 1","step 2"] or [{"title":"step 1"},{"id":"t1","title":"step 2"}]. ' +
          'Example: {"name":"plan.create","args":{"goal":"Assess example.com","detail":"…","tasks":["DNS enum","Port scan","HTTP fingerprint"],"kind":"pentest"}}',
      };
    }
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into separate " +
          "ordered tasks — each a distinct action (scaffold, implement feature, install, run/verify). " +
          "Call plan.create again with a proper tasks array.",
      };
    }

    const existingPlan = await loadPlan(session.sessionId).catch(() => undefined);

    if (
      existingPlan &&
      (existingPlan.status === "completed" ||
        existingPlan.tasks.every(
          (t) =>
            t.state === "done" || t.state === "skipped" || t.state === "failed",
        )) &&
      looksLikeRunOnlyGoal(goal, detail)
    ) {
      return {
        handled: true,
        ok: false,
        display: chalk.yellow(
          "  ⚠ plan.create skipped — use tools to run the existing app\n",
        ),
        modelNote:
          "plan.create rejected: the previous plan is already finished and this goal is only run/verify. " +
          "Do NOT create a new plan or re-list old scaffold tasks. " +
          "Just shell.start the dev server, shell.tail until ready, probe localhost " +
          "(curl or http.fetch with iOwnThis:true), LEAVE the server running, and tell the user " +
          "the URL (http://localhost:<port>), port, and job id.",
      };
    }

    const appendingToActivePlan =
      existingPlan &&
      existingPlan.status !== "draft" &&
      !isPlanTerminal(existingPlan) &&
      (session.planApproved.value ||
        existingPlan.status === "approved" ||
        existingPlan.status === "in_progress");
    if (appendingToActivePlan) {
      const priorIds = new Set(existingPlan.tasks.map((task) => task.id));
      let invalidDependency: string | undefined;
      const appended = await mutatePlan(existingPlan.sessionId, (draft) => {
        let changed = false;
        let previousForegroundId = [...draft.tasks]
          .reverse()
          .find((task) => !task.responderOwned)?.id;
        for (const entry of taskEntries) {
          if (
            isBareTaskIdTitle(entry.title) ||
            draft.tasks.some((task) =>
              titlesMatchForPlan(task.title, entry.title),
            )
          ) {
            continue;
          }
          const dependencies = entry.dependenciesSpecified
            ? entry.dependencies.map((reference) => {
                const resolved = resolvePlanTaskId(draft, reference);
                if (!resolved) invalidDependency = reference;
                return resolved;
              })
            : previousForegroundId
              ? [previousForegroundId]
              : [];
          if (invalidDependency) return false;
          const task = appendPlanTask(draft, {
            title: entry.title,
            state: "pending",
            aliases: entry.aliases,
            dependencies: dependencies.filter(
              (dependency): dependency is string => Boolean(dependency),
            ),
            resourceLocks: entry.resourceLocks,
          });
          previousForegroundId = task.id;
          changed = true;
        }
        return changed;
      }).catch(() => undefined);

      if (!appended?.ok || !appended.plan) {
        const reason = invalidDependency
          ? `unknown dependency "${invalidDependency}"`
          : "every proposed task already exists in ACTIVE PLAN";
        return {
          handled: true,
          ok: false,
          display: chalk.yellow(
            `  ⚠ plan.create kept the active plan — ${reason}\n`,
          ),
          modelNote:
            `plan.create did not replace ACTIVE PLAN: ${reason}. ` +
            "Continue its current in_progress task. Use task.add once per genuinely new task; never recreate or renumber active work.",
        };
      }

      session.planApproved.value = true;
      const addedTasks = appended.plan.tasks.filter(
        (task) => !priorIds.has(task.id),
      );
      const checklist = renderPlanForTerminal(appended.plan);
      return {
        handled: true,
        ok: true,
        plan: appended.plan,
        display:
          chalk.cyan("  ● active plan extended (append-only)\n") +
          checklist +
          "\n" +
          chalk.dim(
            `  ✦ preserved all existing ids/states; appended ${addedTasks.length} new task(s).\n`,
          ),
        modelNote:
          `ACTIVE PLAN was preserved and ${addedTasks.length} genuinely new task(s) were appended as ${addedTasks.map((task) => task.id).join(", ")}. ` +
          "Continue the existing in_progress task first. For later discoveries use task.add, not plan.create; never re-run completed work.",
      };
    }

    const revisablePlan =
      existingPlan &&
      (!isPlanTerminal(existingPlan) ||
        titlesMatchForPlan(existingPlan.goal, goal))
        ? existingPlan
        : undefined;

    const normalizedTitles = revisablePlan
      ? taskTitles
      : normalizeCodingPlanTasks(kind, goal, detail, taskTitles);

    const root = getActiveProjectRoot();
    const pm = root ? detectPackageManager(root) : undefined;
    const meta =
      root || revisablePlan?.meta
        ? {
            ...(revisablePlan?.meta ?? {}),
            ...(root ? { projectRoot: root } : {}),
            ...(pm ? { packageManager: pm } : {}),
          }
        : undefined;

    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles: normalizedTitles,
      kind,
      meta,
    });
    for (let i = 0; i < plan.tasks.length; i++) {
      const aliases = taskEntries[i]?.aliases ?? [];
      if (aliases.length) plan.tasks[i]!.aliases = aliases;
      const locks = taskEntries[i]?.resourceLocks ?? [];
      if (locks.length) plan.tasks[i]!.resourceLocks = locks;
      const acceptanceCriteria = taskEntries[i]?.acceptanceCriteria;
      if (acceptanceCriteria) plan.tasks[i]!.acceptanceCriteria = acceptanceCriteria;
    }
    for (let i = 0; i < plan.tasks.length; i++) {
      const rawDependencies = taskEntries[i]?.dependencies ?? [];
      const dependencies = rawDependencies.map(
        (dependency) => resolvePlanTaskId(plan, dependency) ?? dependency,
      );
      if (taskEntries[i]?.dependenciesSpecified) {
        plan.tasks[i]!.dependencies = [...new Set(dependencies)];
      }
    }

    let additiveOnly = false;
    if (revisablePlan) {
      plan.version = (revisablePlan.version ?? 1) + 1;
      const usedOldIds = new Set<string>();
      const matchedIndices = new Set<number>();
      const mappedNewTasks = plan.tasks.map((task, index) => {
        const match = revisablePlan.tasks.find(
          (t) =>
            !usedOldIds.has(t.id) && titlesMatchForPlan(t.title, task.title),
        );
        if (match) {
          usedOldIds.add(match.id);
          matchedIndices.add(index);
          return {
            ...task,
            id: match.id,
            state: match.state,
            note: match.note,
            acceptanceCriteria:
              task.acceptanceCriteria ?? match.acceptanceCriteria,
            evidence: match.evidence,
            parentTaskId: match.parentTaskId,
            jobId: match.jobId,
            processId: match.processId,
            responderOwned: match.responderOwned,
          };
        }
        return task;
      });

      const taken = new Set(
        [...matchedIndices].map((i) => mappedNewTasks[i]!.id),
      );
      for (let i = 0; i < mappedNewTasks.length; i++) {
        if (matchedIndices.has(i)) continue;
        const task = mappedNewTasks[i]!;
        if (taken.has(task.id)) {
          let id = nextTaskId([...taken]);
          while (taken.has(id)) id = nextTaskId([...taken, id]);
          task.id = id;
        }
        taken.add(task.id);
      }

      const isDraftRewrite =
        revisablePlan.status === "draft" && !session.planApproved.value;

      if (isDraftRewrite) {
        plan.tasks = mappedNewTasks.filter((t) => !isBareTaskIdTitle(t.title));
      } else {
        const oldTasksToKeep = revisablePlan.tasks
          .filter(
            (oldTask) =>
              !isBareTaskIdTitle(oldTask.title) &&
              !mappedNewTasks.some((newTask) =>
                titlesMatchForPlan(oldTask.title, newTask.title),
              ),
          )
          .map((oldTask) => {
            if (oldTask.responderOwned) return oldTask;
            if (
              oldTask.state === "done" ||
              oldTask.state === "skipped" ||
              oldTask.state === "failed"
            ) {
              return oldTask;
            }
            if (oldTask.state === "in_progress") {
              return {
                ...oldTask,
                state: "skipped" as const,
                note: oldTask.note ?? "superseded by plan revision",
              };
            }
            return null;
          })
          .filter((t): t is NonNullable<typeof t> => Boolean(t));

        plan.tasks = [...oldTasksToKeep, ...mappedNewTasks].filter(
          (t) => !isBareTaskIdTitle(t.title),
        );
      }

      const finalIdByInputReference = new Map<string, string>();
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        const task = mappedNewTasks[index]!;
        const entry = taskEntries[index];
        finalIdByInputReference.set(task.id, task.id);
        finalIdByInputReference.set(slugifyTaskId(task.title), task.id);
        for (const alias of entry?.aliases ?? []) {
          finalIdByInputReference.set(alias, task.id);
        }
      }
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        finalIdByInputReference.set(`t${index + 1}`, mappedNewTasks[index]!.id);
      }
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        const task = mappedNewTasks[index]!;
        const entry = taskEntries[index];
        const references = entry?.dependenciesSpecified
          ? entry.dependencies
          : index > 0
            ? [mappedNewTasks[index - 1]!.id]
            : [];
        task.dependencies = [
          ...new Set(
            references
              .map(
                (reference) =>
                  finalIdByInputReference.get(reference) ??
                  resolvePlanTaskId(plan, reference) ??
                  reference,
              )
              .filter((id) => id !== task.id),
          ),
        ];
      }

      const priorFinished = revisablePlan.tasks.filter(
        (t) =>
          t.state === "done" || t.state === "skipped" || t.state === "failed",
      );
      const finishedStillFinished =
        priorFinished.length > 0 &&
        priorFinished.every((old) =>
          plan.tasks.some(
            (n) =>
              titlesMatchForPlan(old.title, n.title) &&
              (n.state === "done" ||
                n.state === "skipped" ||
                n.state === "failed"),
          ),
        );
      const hasNewPending = plan.tasks.some((t) => t.state === "pending");
      const noDoneReopened = !plan.tasks.some((n) => {
        const old = revisablePlan.tasks.find((t) =>
          titlesMatchForPlan(t.title, n.title),
        );
        return (
          old &&
          (old.state === "done" || old.state === "skipped") &&
          n.state === "pending"
        );
      });
      additiveOnly =
        finishedStillFinished &&
        hasNewPending &&
        noDoneReopened &&
        (session.planApproved.value ||
          revisablePlan.status === "approved" ||
          revisablePlan.status === "in_progress" ||
          revisablePlan.status === "completed");

      if (additiveOnly) {
        plan.status = "in_progress";
        plan.createdAt = revisablePlan.createdAt;
      }
    }

    normalizeTaskDependencies(plan.tasks);

    const dag = validateSessionPlan(plan);
    if (!dag.ok) {
      for (let i = 0; i < plan.tasks.length; i++) {
        plan.tasks[i]!.dependencies = i > 0 ? [plan.tasks[i - 1]!.id] : [];
      }
      const again = validateSessionPlan(plan);
      if (!again.ok) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ plan.create: invalid dependency graph — ${again.reason}\n`,
          ),
          modelNote: `plan.create failed: ${again.reason}. Use only declared task ids/aliases and remove dependency cycles.`,
        };
      }
    }

    if (additiveOnly) {
      session.planApproved.value = true;
      plan.status = "in_progress";
    } else if (autoApprove) {
      session.planApproved.value = true;
      plan.status = "approved";
    } else {
      session.planApproved.value = false;
    }

    const revised = await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, plan);
      return true;
    }).catch(() => undefined);
    if (!revised?.ok) {
      await savePlan(plan).catch(() => undefined);
    } else if (revised.plan) {
      plan.tasks = revised.plan.tasks;
      plan.version = revised.plan.version;
    }

    const checklist = renderPlanForTerminal(plan);
    const display = additiveOnly
      ? chalk.cyan("  ● plan updated (additive)\n") +
        checklist +
        "\n" +
        chalk.dim(
          "  ✦ done tasks preserved — continue from the first pending task only.\n" +
            "    Do NOT re-run completed scaffold/build work.\n",
        )
      : autoApprove
        ? chalk.cyan("  ● plan created (auto-approved)\n") +
          checklist +
          "\n" +
          chalk.dim(
            "  ✦ plan approved in agent mode — continue executing task by task.\n",
          )
        : chalk.cyan("  ● planning\n") +
          checklist +
          "\n" +
          chalk.dim(
            "  ✦ plan created — Accept to run, Discard, View, or Suggest changes\n" +
              "    (/implement, /discard, Ctrl+P also work).\n",
          );

    const firstPending = readyPlanTasks(plan)[0];
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote: additiveOnly
        ? `Plan updated with additive task(s); ${plan.tasks.filter((t) => t.state === "done" || t.state === "skipped").length} prior task(s) stay done. ` +
          "Do NOT re-execute completed tasks (no re-scaffold). " +
          (firstPending
            ? `Continue from [${firstPending.id}] "${firstPending.title}" only. `
            : "") +
          "If the only new work is run/verify on an existing app, prefer shell.start + probe + report URL — " +
          "do not reboot the world. When the run/verify task finishes, final message MUST include " +
          "http://localhost:<port>, port, job id, and that the server is still running."
        : autoApprove
          ? `Plan saved and approved with ${plan.tasks.length} task(s). Execute now. ` +
            (firstPending
              ? `Start with [${firstPending.id}] "${firstPending.title}". `
              : "") +
            "task.update in_progress → work → verify → done. When run/verify completes: report URL, port, job id, server still running."
          : `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
            "Do NOT start executing until the user accepts the plan. " +
            "If the user's next message gives feedback, that is a REVISION: call plan.create once with the COMPLETE " +
            "updated goal/detail/tasks (full list — omit obsolete steps; do not leave old backend/DB tasks when " +
            "the user dropped them). Then STOP again. Be decisive; do not monologue alternatives. " +
            "The user may discard the plan. After acceptance: task.update in_progress → work → verify → done. " +
            "When run/verify completes: report URL, port, job id, and that the server is still running.",
    };
}
