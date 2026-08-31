import {
  isPlanSuccessful,
  isPlanTerminal,
  mutatePlan,
  type SessionPlan,
} from "./plan.js";
import type { BackgroundJob } from "../tools/jobs.js";

export type ResponderSettlementResult =
  | "applied"
  | "noop"
  | "missing"
  | "retry";

function artifactPath(job: BackgroundJob): string {
  return job.artifacts.stdout.chunks.at(-1) ?? job.stdoutArtifact;
}

function settlement(job: BackgroundJob): {
  state: "done" | "failed";
  note: string;
} {
  const state = job.status === "exited" && job.exitCode === 0 ? "done" : "failed";
  return {
    state,
    note:
      `job=${job.id} status=${job.status} exit=${job.exitCode ?? "?"}` +
      `${job.signal ? ` signal=${job.signal}` : ""} artifact=${artifactPath(job)}`,
  };
}

function updatePlanStatus(plan: SessionPlan): void {
  if (isPlanTerminal(plan)) {
    plan.status = isPlanSuccessful(plan) ? "completed" : "abandoned";
  } else if (plan.status !== "draft") {
    plan.status = "in_progress";
  }
}

export interface ResponderSettlementOptions {
  readonly resultRevision?: number | undefined;
}

export async function settleResponderJob(
  job: BackgroundJob,
  options?: ResponderSettlementOptions,
): Promise<ResponderSettlementResult> {
  if (!job.responder || !["exited", "failed", "killed", "lost"].includes(job.status)) {
    return "noop";
  }

  const next = settlement(job);
  const resultRevision = options?.resultRevision ?? 1;
  let outcome: Exclude<ResponderSettlementResult, "applied"> | undefined;

  let result: Awaited<ReturnType<typeof mutatePlan>>;
  try {
    result = await mutatePlan(job.ownerSessionId, (draft) => {
      outcome = undefined;
      const task = draft.tasks.find(
        (candidate) =>
          candidate.responderOwned &&
          (candidate.jobId === job.id ||
            candidate.id === job.taskId ||
            (job.delegationId !== undefined &&
              candidate.delegationId === job.delegationId)),
      );
      if (!task) {
        outcome = "missing";
        return false;
      }
      if (
        task.state === next.state &&
        task.note === next.note &&
        task.jobId === job.id &&
        (task.settledResultRevision ?? 0) >= resultRevision
      ) {
        outcome = "noop";
        return false;
      }
      task.state = next.state;
      task.note = next.note;
      task.settledResultRevision = resultRevision;
      task.jobId = job.id;
      task.processId = job.pid;
      task.responderOwned = true;
      updatePlanStatus(draft);
      return true;
    });
  } catch {
    return "retry";
  }

  if (result.ok) return "applied";
  if (outcome) return outcome;
  if (result.reason === "missing-plan") return "missing";
  return "retry";
}
