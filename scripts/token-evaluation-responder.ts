import { deliveryPrompt } from "../src/app/controllers/session-responder.js";
import type { JobManager } from "../src/tools/jobs.js";

type EvaluationJobs = Pick<JobManager, "activateResponderLease" | "claimNextResponderNotification" | "tailJob" | "markDeliveryStarted">;

export async function prepareEvaluationResponderWake(jobs: EvaluationJobs, sessionId: string) {
  const leaseId = jobs.activateResponderLease(sessionId);
  const notification = jobs.claimNextResponderNotification(sessionId, leaseId);
  if (!notification) throw new Error("Responder fixture has no owned deliverable completion");
  const preview = await jobs.tailJob(notification.jobId, 4096);
  if (!preview.ok || !jobs.markDeliveryStarted(notification.id, sessionId)) throw new Error("Responder fixture delivery failed");
  return { prompt: deliveryPrompt(notification, preview.output.split("\n").slice(0, 20).join("\n"), undefined), displayPrompt: null, notification, leaseId };
}
