

export type JobStatus = "starting" | "running" | "exited" | "failed" | "stopping" | "killed" | "lost";

export type JobTerminalStatus = Exclude<JobStatus, "starting" | "running" | "stopping">;

export interface JobArtifactReceipt {
  path: string;
  chunks: string[];
  bytes: number;
  droppedBytes: number;
  redacted: boolean;
  sha256: string;
}

export type JobMonitorMetadata = Record<string, unknown>;

export interface JobLinkMetadata {
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  /**
   * Stable delegation identity minted before launch. It is the
   * reconciliation key between a job and its responder child task, so a fast
   * exit or a failed link cannot orphan the child.
   */
  delegationId?: string | undefined;
  wakeOnCompletion?: boolean | undefined;
  monitor?: JobMonitorMetadata | undefined;
  /** Runtime listening lease that authorized this responder delegation. */
  responderLeaseId?: string | undefined;
  /**
   * Opt-in delegation to the Responder: fire-and-continue, plan subtask +
   * auto-wake on completion, and inclusion in the Responder inbox/UI. When
   * false/absent the job is a plain background job the agent polls itself
   * (shell.jobs/shell.tail) exactly as before Responder existed.
   */
  responder?: boolean | undefined;
}

/**
 * durable  — shell.start / auto-backgrounded servers (listed by shell.jobs, persisted)
 * ephemeral — per-tool stall tracking in the agent runner (never listed, never persisted)
 */
export type JobKind = "durable" | "ephemeral";

export interface BackgroundJob extends JobLinkMetadata {
  id: string;
  command: string;
  commandDisplay: string;
  cwd: string;
  pid?: number | undefined;
  processGroupId?: number | undefined;
  processIdentity?: string | undefined;
  status: JobStatus;
  startedAt: string;
  heartbeatAt?: string | undefined;
  endedAt?: string | undefined;
  exitCode?: number | undefined;
  signal?: string | undefined;
  artifactPath: string;
  stdoutArtifact: string;
  stderrArtifact: string;
  artifacts: { stdout: JobArtifactReceipt; stderr: JobArtifactReceipt };
  redactionProfile: string;
  ownerSessionId: string;
  /** Default durable for registry records; ephemeral for tool-stall tracking. */
  kind?: JobKind | undefined;
  name?: string | undefined;
  authorization?: { target: string; expiresAt?: string | undefined } | undefined;
  /** Accepted when reading legacy registries but never armed or restored. */
  timeoutAt?: string | undefined;
}

export interface SupersededResultRevision {
  resultRevision: number;
  resultHash: string;
  status: JobTerminalStatus;
  endedAt: string;
  exitCode?: number | undefined;
  signal?: string | undefined;
  deliveredAt?: string | undefined;
  readAt?: string | undefined;
  analyzedAt?: string | undefined;
  acknowledgedAt?: string | undefined;
  settledAt?: string | undefined;
}

export interface ResponderNotification {
  id: string;
  ownerSessionId: string;
  jobId: string;
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  status: JobTerminalStatus;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number | undefined;
  signal?: string | undefined;
  stdoutArtifact: JobArtifactReceipt;
  stderrArtifact: JobArtifactReceipt;
  commandDisplay: string;
  wakeOnCompletion: boolean;
  responder: boolean;
  monitor?: JobMonitorMetadata | undefined;
  responderLeaseId?: string | undefined;
  /** A delivery attempt began; not durable consumption. Cleared claims may retry. */
  deliveryStartedAt?: string | undefined;
  deliveredAt?: string | undefined;
  readAt?: string | undefined;
  analyzedAt?: string | undefined;
  acknowledgedAt?: string | undefined;
  /** User discarded this receipt (cancel/new session); never model analysis. */
  discardedAt?: string | undefined;
  discardReason?: "session-cancelled" | undefined;
  /** Monotonic revision of the authoritative result this receipt carries. */
  resultRevision?: number | undefined;
  /** Content hash of the authoritative result, used to detect a correction. */
  resultHash?: string | undefined;
  /** Bounded audit trail of revisions this receipt superseded. */
  supersededRevisions?: readonly SupersededResultRevision[] | undefined;
  archivedAt?: string | undefined;
  settledAt?: string | undefined;
}

export type JobManagerChange =
  | { type: "job"; jobId: string }
  | { type: "notification"; jobId: string; notificationId: string };

export type JobManagerListener = (change: JobManagerChange) => void;

interface PersistedRegistryV1 { schemaVersion: 1; jobs: BackgroundJob[] }

export interface PersistedRegistryV2 {
  schemaVersion: 2;
  jobs: BackgroundJob[];
  notifications: ResponderNotification[];
  settlements?: PendingSettlement[];
  consumedResults?: ConsumedResponderResult[];
}

export interface ConsumedResponderResult {
  jobId: string;
  resultHash: string;
  resultRevision: number;
  acknowledgedAt: string;
}

/** Durable projection marker for a terminal result whose plan child is unsettled. */
export interface PendingSettlement {
  jobId: string;
  resultRevision: number;
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  lastReason: string;
  deadLetteredAt?: string | undefined;
}

export type PersistedRegistry = PersistedRegistryV1 | PersistedRegistryV2;

/** Safe detached process form. stdinText is written once, then stdin is closed. */
export interface BackgroundSpawnSpec {
  command: string;
  argv: string[];
  stdinText?: string | undefined;
  /** Non-secret display text persisted in the registry and artifacts. */
  display?: string | undefined;
}

export interface StartJobOptions extends JobLinkMetadata {
  cwd?: string | undefined;
  name?: string | undefined;
  ownerSessionId?: string | undefined;
  profile?: string | undefined;
  estimatedSeconds?: number | undefined;
  /** Legacy compatibility input. Durable jobs no longer have generic deadlines. */
  timeoutMs?: number | undefined;
  authorization?: { target: string; expiresAt?: string | undefined } | undefined;
}
