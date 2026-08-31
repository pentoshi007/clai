

export const DEFAULT_TAIL_BYTES = 8_000;

export const WAIT_JOB_DEFAULT_TIMEOUT_MS = 120_000;

export const WAIT_JOB_MAX_TIMEOUT_MS = 600_000;

export const WAIT_JOB_INTERVAL_MS = 500;

export const WAIT_JOB_TAIL_BYTES = 4_000;

export const REGISTRY_FILE = "registry-v1.json";

export const TRANSIENT_V2_REGISTRY_FILE = "registry-v2.json";

/** Cap durable terminal jobs kept on disk/in memory (per process). */
export const MAX_DURABLE_TERMINAL_JOBS = 80;

/** Drop terminal durable jobs older than this on load/list. */
export const TERMINAL_JOB_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const ARCHIVED_UNSETTLED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const MAX_ARCHIVED_UNSETTLED_NOTIFICATIONS = 40;

export const MAX_SUPERSEDED_REVISIONS = 5;

export const SETTLEMENT_MAX_BACKOFF_MS = 30_000;

export const LIVENESS_WATCH_INTERVAL_MS = 2_000;

export const SETTLEMENT_DEAD_LETTER_MS = 10 * 60_000;

/** Max lines shell.jobs returns to the model (running first, then recent). */
export const LIST_JOBS_MAX_LINES = 40;

/** Coalesce window for chatty stdout/stderr progress persistence + UI events. */
export const PROGRESS_FLUSH_MS = 250;

/** Durable registry cadence for running-job progress (UI updates stay at 250ms). */
export const DURABLE_PROGRESS_FLUSH_MS = 5_000;

/**
 * A live job with no in-process ChildProcess handle (resumed session, or a
 * handle that was released) is only declared "lost" after failing the liveness
 * check continuously for this long. A single transient `ps`/`kill` hiccup — or
 * an identity read that momentarily fails — must never finalize a job that is
 * actually still running (which produced premature "result ready", a "<1s"
 * elapsed, and a ✗ status=lost that later flipped back to exit=0).
 */
export const LIVENESS_LOST_GRACE_MS = 8_000;

/** Minimum spacing between liveness probes for the same job. */
export const LIVENESS_PROBE_INTERVAL_MS = 1_000;
