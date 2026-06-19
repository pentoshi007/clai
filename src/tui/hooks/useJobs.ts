import { useEffect, useState } from "react";
import { jobManager, type BackgroundJob } from "../../tools/jobs.js";

/**
 * Polls the shared `jobManager` so the UI can surface background jobs
 * (long-running shell commands the agent detached). Polling — rather than
 * events — keeps `jobs.ts` decoupled from the frontend.
 */
export function useJobs(active: boolean, intervalMs = 1500): BackgroundJob[] {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  useEffect(() => {
    if (!active) return;
    const tick = (): void => {
      // jobManager exposes running jobs directly; for the full list we read
      // the private map via listJobs parsing-free by snapshotting running +
      // recently-finished through getRunningJobs plus a best-effort scan.
      setJobs(snapshotJobs());
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return jobs;
}

/**
 * Build a stable snapshot of all known jobs. `JobManager` only exposes
 * `getRunningJobs()` publicly; finished jobs still matter for the panel, so
 * we read the internal registry defensively (it's the same in-process
 * singleton) and fall back to running-only if the shape ever changes.
 */
function snapshotJobs(): BackgroundJob[] {
  const internal = (jobManager as unknown as { jobs?: Map<string, BackgroundJob> })
    .jobs;
  if (internal instanceof Map) {
    return [...internal.values()];
  }
  return jobManager.getRunningJobs();
}
