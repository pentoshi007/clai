import type { ToolCall, ToolResult } from "../../types.js";
import type { PlanTask, SessionPlan } from "../../store/plan.js";
import type { BackgroundJob } from "../../tools/jobs.js";
import { appendPlanTask, isPlanSuccessful, isPlanTerminal } from "../../store/plan.js";

export interface ResponderLinkageJobPatch {
  readonly taskId?: string | undefined;
  readonly parentTaskId?: string | undefined;
  readonly wakeOnCompletion: boolean;
  readonly responder: boolean;
  readonly monitor: Record<string, unknown>;
}

export interface ResponderLinkagePorts {
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly mutatePlan: (
    mutator: (draft: SessionPlan) => boolean,
  ) => Promise<{ ok: boolean; plan?: SessionPlan | undefined } | undefined>;
  readonly linkJob: (
    jobId: string,
    patch: ResponderLinkageJobPatch,
  ) => BackgroundJob | undefined;
  readonly renderPlan: (plan: SessionPlan) => void;
  readonly setPendingSessionStatePlan: (plan: SessionPlan) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
}

export interface ResponderLinkageInput {
  readonly job: BackgroundJob;
  readonly call: ToolCall;
  readonly toolEventId: string;
  readonly delegationTaskId: string | undefined;
  readonly dispatchedTaskId: string | undefined;
}

interface UpsertOutcome {
  readonly childId: string | undefined;
  readonly parentTaskId: string | undefined;
  readonly plan: SessionPlan | undefined;
}

const terminalStateFor = (job: BackgroundJob): PlanTask["state"] => {
  if (job.status === "exited") return "done";
  if (
    job.status === "failed" ||
    job.status === "killed" ||
    job.status === "lost"
  ) {
    return "failed";
  }
  return "in_progress";
};

const noteFor = (job: BackgroundJob): string =>
  `job=${job.id} pid=${job.pid ?? "?"} status=${job.status} ` +
  `artifact=${job.stdoutArtifact}`;

const titleFor = (job: BackgroundJob): string =>
  `Responder · ${job.name ?? job.commandDisplay.slice(0, 96)}`;

interface ChildMutationInput {
  readonly job: BackgroundJob;
  readonly parentTaskId: string | undefined;
  readonly terminalState: PlanTask["state"];
  readonly note: string;
}

const findResponderChild = (
  draft: SessionPlan,
  job: BackgroundJob,
): PlanTask | undefined =>
  (job.delegationId
    ? draft.tasks.find((task) => task.delegationId === job.delegationId)
    : undefined) ?? draft.tasks.find((task) => task.jobId === job.id);

const applyPlanStatus = (draft: SessionPlan): void => {
  if (isPlanTerminal(draft)) {
    draft.status = isPlanSuccessful(draft) ? "completed" : "abandoned";
    return;
  }
  if (draft.status !== "draft") draft.status = "in_progress";
};

const applyResponderChild = (
  draft: SessionPlan,
  input: ChildMutationInput,
): PlanTask => {
  const child =
    findResponderChild(draft, input.job) ??
    appendPlanTask(draft, {
      title: titleFor(input.job),
      state: input.terminalState,
      note: input.note,
      dependencies: [],
      resourceLocks: [],
      parentTaskId: input.parentTaskId,
      jobId: input.job.id,
      processId: input.job.pid,
      responderOwned: true,
      ...(input.job.delegationId
        ? { delegationId: input.job.delegationId }
        : {}),
    });
  if (child.state !== "done" && child.state !== "failed") {
    child.state = input.terminalState;
    child.note = input.note;
  }
  child.jobId = input.job.id;
  child.processId = input.job.pid;
  child.responderOwned = true;
  if (input.job.delegationId) child.delegationId = input.job.delegationId;
  if (input.parentTaskId) child.parentTaskId = input.parentTaskId;
  applyPlanStatus(draft);
  return child;
};

const upsertResponderChild = async (
  ports: ResponderLinkagePorts,
  input: ResponderLinkageInput,
  livePlan: SessionPlan,
): Promise<UpsertOutcome> => {
  const job = input.job;
  const parentTaskId =
    input.dispatchedTaskId &&
    livePlan.tasks.some((task) => task.id === input.dispatchedTaskId)
      ? input.dispatchedTaskId
      : undefined;
  const mutation: ChildMutationInput = {
    job,
    parentTaskId,
    terminalState: terminalStateFor(job),
    note: noteFor(job),
  };
  let childId: string | undefined;
  const upsert = await ports
    .mutatePlan((draft) => {
      childId = applyResponderChild(draft, mutation).id;
      return true;
    })
    .catch(() => undefined);

  if (!upsert?.ok || !childId) {
    ports.notify(
      "warn",
      `Responder job ${job.id} started, but its plan subtask could not be persisted`,
    );
    return { childId: undefined, parentTaskId, plan: undefined };
  }
  const rendered = upsert.plan ?? livePlan;
  ports.setPendingSessionStatePlan(rendered);
  ports.renderPlan(rendered);
  return { childId, parentTaskId, plan: rendered };
};

export const responderLinkageNote = (
  jobId: string,
  responderTaskId: string,
  parentTaskId: string | undefined,
): string =>
  `\nResponder linked job ${jobId} to subtask [${responderTaskId}]` +
  `${parentTaskId ? ` under [${parentTaskId}]` : ""}. ` +
  "This child subtask advances on its own from the real process result — do not mark, poll, or wait on it. " +
  "Mark your current launch step done and move to the next task now; do NOT shell.tail/shell.jobs/sleep to watch it. " +
  "The Responder delivers the completion into your context automatically when it is ready.";

export const linkResponderJobToPlan = async (
  ports: ResponderLinkagePorts,
  input: ResponderLinkageInput,
  result: ToolResult,
): Promise<ToolResult> => {
  const livePlan = await ports.loadPlan();
  let linkedTaskId = input.delegationTaskId;
  let linkedParentTaskId: string | undefined;
  let responderTaskId: string | undefined;
  if (livePlan) {
    const outcome = await upsertResponderChild(ports, input, livePlan);
    if (outcome.childId) {
      linkedTaskId = outcome.childId;
      linkedParentTaskId = outcome.parentTaskId;
      responderTaskId = outcome.childId;
    }
  }
  const linkedJob = ports.linkJob(input.job.id, {
    ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
    ...(linkedParentTaskId ? { parentTaskId: linkedParentTaskId } : {}),
    wakeOnCompletion: true,
    responder: true,
    monitor: {
      ...(input.job.monitor ?? {}),
      toolName: input.call.name,
      toolEventId: input.toolEventId,
    },
  });
  if (!linkedJob) {
    ports.notify(
      "warn",
      `Responder job ${input.job.id} started, but durable task linkage will be retried on completion`,
    );
    return result;
  }
  if (!responderTaskId) return result;
  return {
    ...result,
    output: `${result.output}${responderLinkageNote(input.job.id, responderTaskId, linkedParentTaskId)}`,
  };
};
