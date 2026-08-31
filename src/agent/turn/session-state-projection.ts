import type { BackgroundJob } from "../../tools/jobs.js";
import type { SessionPlan } from "../../store/plan.js";
import {
  inferNextHint,
  type SessionStateSnapshot,
} from "../session-state.js";

export interface SessionStateProjectionInput {
  readonly plan: SessionPlan | undefined;
  readonly prompt: string;
  readonly projectRoot: string | undefined;
  readonly packageManager: string | undefined;
  readonly runningJobs: readonly BackgroundJob[];
  readonly featureAppRequired: boolean;
  readonly featureSeen: boolean;
  readonly scaffoldOk: boolean;
  readonly serverStarted: boolean;
  readonly serverProbedOk: boolean;
  readonly lastProbeFailed: boolean;
  readonly lastOkTool: string | undefined;
  readonly pentestSession: boolean;
}

const MAX_JOB_BITS = 4;
const MAX_GOAL_CHARS = 160;
const MAX_JOB_COMMAND_CHARS = 40;

const jobSummary = (runningJobs: readonly BackgroundJob[]): string | undefined => {
  const bits = runningJobs.slice(0, MAX_JOB_BITS).map((job) => {
    const command = (job.commandDisplay || job.command)
      .replace(/\s+/g, " ")
      .trim();
    return `${job.id} ${job.status} ${command.slice(0, MAX_JOB_COMMAND_CHARS)}`;
  });
  return bits.length > 0
    ? `${runningJobs.length} running: ${bits.join("; ")}`
    : undefined;
};

export const buildTurnSessionStateSnapshot = (
  input: SessionStateProjectionInput,
): SessionStateSnapshot => {
  const plan = input.plan;
  const open = plan?.tasks.find(
    (task) => task.state === "in_progress" && !task.responderOwned,
  );
  const snapshot: SessionStateSnapshot = {
    goal: plan?.goal ?? input.prompt.slice(0, MAX_GOAL_CHARS),
    projectRoot: input.projectRoot,
    packageManager: input.packageManager,
    planStatus: plan?.status,
    planKind: plan?.kind,
    openTask: open ? `[${open.id}] ${open.title}` : undefined,
    pendingTasks: plan?.tasks
      .filter((task) => task.state === "pending" && !task.responderOwned)
      .map((task) => `[${task.id}] ${task.title}`),
    doneTasks: plan?.tasks
      .filter((task) => task.state === "done" || task.state === "skipped")
      .map((task) => task.id),
    featureAppRequired: input.featureAppRequired,
    featureSeen: input.featureSeen,
    scaffoldOk: input.scaffoldOk,
    serverStarted: input.serverStarted,
    serverProbedOk: input.serverProbedOk,
    lastProbeFailed: input.lastProbeFailed,
    lastOkTool: input.lastOkTool,
    backgroundJobs: jobSummary(input.runningJobs),
    engagementNote: input.pentestSession
      ? "remote/security engagement — no local dev server as completion"
      : undefined,
  };
  snapshot.nextHint = inferNextHint(snapshot);
  return snapshot;
};
