import type { ToolCall } from "../../types.js";
import type { BackgroundJob, JobStatus } from "../jobs.js";

export interface ResponderPollingPolicyInput {
  call: ToolCall;
  targetJob?: BackgroundJob | undefined;
  recentJobs?: readonly BackgroundJob[] | undefined;
}

const LIVE_JOB_STATUSES = new Set<JobStatus>([
  "starting",
  "running",
  "stopping",
]);

export function responderPollingPolicy(
  input: ResponderPollingPolicyInput,
): { blocked: boolean; reason?: string | undefined } {
  if (
    input.call.name === "shell.tail" &&
    input.targetJob?.responder &&
    LIVE_JOB_STATUSES.has(input.targetJob.status)
  ) {
    return {
      blocked: true,
      reason:
        `Responder owns job ${input.targetJob.id}; shell.tail was not dispatched. ` +
        "This job is fire-and-continue: its terminal result will be delivered automatically. " +
        "Continue other work, and call job.read only after analyzing that delivered completion.",
    };
  }

  if (input.call.name === "shell.jobs") {
    const recent = input.recentJobs ?? [];
    const runningResponderJobs = recent.filter(
      (job) => job.responder && LIVE_JOB_STATUSES.has(job.status),
    );
    const visibleNormalJobs = recent.filter((job) => !job.responder);
    if (runningResponderJobs.length > 0 && visibleNormalJobs.length === 0) {
      const ids = runningResponderJobs.map((job) => job.id).join(", ");
      return {
        blocked: true,
        reason:
          `shell.jobs was not dispatched because the only running background job(s) (${ids}) are Responder-owned. ` +
          "They are fire-and-continue and their terminal results will be delivered automatically. " +
          "Continue other work; do not sleep or poll, and call job.read only after analyzing a delivered completion.",
      };
    }
  }

  return { blocked: false };
}
