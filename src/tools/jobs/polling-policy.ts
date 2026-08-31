import type { ToolCall } from "../../types.js";
import type { BackgroundJob, JobStatus } from "../jobs.js";

export interface ResponderPollingPolicyInput {
  call: ToolCall;
  targetJob?: BackgroundJob | undefined;
  /** Jobs in the exact shell.jobs display window, in display order. */
  recentJobs?: readonly BackgroundJob[] | undefined;
}

/**
 * Responder-owned jobs are push-delivered and must not be polled. Normal jobs
 * remain pollable, including mixed sessions with a visible terminal normal job.
 */
const LIVE_JOB_STATUSES = new Set<JobStatus>([
  "starting",
  "running",
  "stopping",
]);

export function responderPollingPolicy(
  input: ResponderPollingPolicyInput,
): { blocked: boolean; reason?: string | undefined } {
  // Only a still-running Responder job can be polled in a loop. Once it is
  // terminal its output is fixed, so reading it is a normal bounded read and
  // blocking it would remove the only way to inspect the full result.
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
