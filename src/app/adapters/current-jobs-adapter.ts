import { jobManager, type JobManager } from "../../tools/jobs.js";
import type { JobsPort } from "../ports/jobs-port.js";

/** Backs `JobsPort` with the shared background-job manager. */
export function createCurrentJobsPort(manager: JobManager = jobManager): JobsPort {
  return {
    list: () => manager.listJobs(),
    running: () => manager.getRunningJobs(),
    get: (id) => manager.getJob(id),
    tail: (id, bytes) => manager.tailJob(id, bytes),
    stop: (id) => manager.stopJob(id),
    start: (command, options) => manager.startJob(command, options),
  };
}
