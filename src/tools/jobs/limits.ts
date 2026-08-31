

export const DEFAULT_TAIL_BYTES = 8_000;

export const WAIT_JOB_DEFAULT_TIMEOUT_MS = 120_000;

export const WAIT_JOB_MAX_TIMEOUT_MS = 600_000;

export const WAIT_JOB_INTERVAL_MS = 500;

export const WAIT_JOB_TAIL_BYTES = 4_000;

export const REGISTRY_FILE = "registry-v1.json";

export const TRANSIENT_V2_REGISTRY_FILE = "registry-v2.json";

export const MAX_DURABLE_TERMINAL_JOBS = 80;

export const TERMINAL_JOB_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const ARCHIVED_UNSETTLED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const MAX_ARCHIVED_UNSETTLED_NOTIFICATIONS = 40;

export const MAX_SUPERSEDED_REVISIONS = 5;

export const SETTLEMENT_MAX_BACKOFF_MS = 30_000;

export const LIVENESS_WATCH_INTERVAL_MS = 2_000;

export const SETTLEMENT_DEAD_LETTER_MS = 10 * 60_000;

export const LIST_JOBS_MAX_LINES = 40;

export const PROGRESS_FLUSH_MS = 250;

export const DURABLE_PROGRESS_FLUSH_MS = 5_000;

export const LIVENESS_LOST_GRACE_MS = 8_000;

export const LIVENESS_PROBE_INTERVAL_MS = 1_000;
