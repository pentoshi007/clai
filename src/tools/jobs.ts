import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { ToolResult } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { getJobsDir } from "../store/paths.js";
import { resolveShell } from "./shell.js";
import { terminateProcessTree } from "../os/process-tree.js";
import { forgetProcessIdentity, processAlive, processIdentity } from "./jobs/process-identity.js";
import { RotatingRedactedWriter } from "./jobs/redacted-writer.js";
import { responderPollingPolicy } from "./jobs/polling-policy.js";
import { ARCHIVED_UNSETTLED_MAX_AGE_MS, DEFAULT_TAIL_BYTES, DURABLE_PROGRESS_FLUSH_MS, LIST_JOBS_MAX_LINES, LIVENESS_LOST_GRACE_MS, LIVENESS_PROBE_INTERVAL_MS, LIVENESS_WATCH_INTERVAL_MS, MAX_ARCHIVED_UNSETTLED_NOTIFICATIONS, MAX_DURABLE_TERMINAL_JOBS, MAX_SUPERSEDED_REVISIONS, PROGRESS_FLUSH_MS, REGISTRY_FILE, SETTLEMENT_DEAD_LETTER_MS, SETTLEMENT_MAX_BACKOFF_MS, TERMINAL_JOB_MAX_AGE_MS, TRANSIENT_V2_REGISTRY_FILE, WAIT_JOB_DEFAULT_TIMEOUT_MS, WAIT_JOB_INTERVAL_MS, WAIT_JOB_MAX_TIMEOUT_MS, WAIT_JOB_TAIL_BYTES } from "./jobs/limits.js";
import { commandDisplay, formatJobElapsed, launchFollowUp, looksLikeEphemeralToolTrack, trailingIncompleteBytes } from "./jobs/helpers.js";
import { BackgroundJob, BackgroundSpawnSpec, ConsumedResponderResult, JobArtifactReceipt, JobLinkMetadata, JobManagerChange, JobManagerListener, JobStatus, JobTerminalStatus, PendingSettlement, PersistedRegistry, PersistedRegistryV2, ResponderNotification, StartJobOptions } from "./jobs/types.js";
export type { BackgroundJob, BackgroundSpawnSpec, JobArtifactReceipt, JobKind, JobLinkMetadata, JobManagerChange, JobManagerListener, JobMonitorMetadata, JobStatus, JobTerminalStatus, PendingSettlement, ResponderNotification, StartJobOptions, SupersededResultRevision } from "./jobs/types.js";
export { formatJobElapsed };
export { responderPollingPolicy };
export type { ResponderPollingPolicyInput } from "./jobs/polling-policy.js";

interface TailCursor { stream?: "stdout" | "stderr" | "combined"; offset?: number; bytes?: number }

export class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private notifications = new Map<string, ResponderNotification>();
  private readonly claimedNotifications = new Set<string>();
  private processes = new Map<string, ChildProcess>();
  private writers = new Map<string, { stdout: RotatingRedactedWriter; stderr: RotatingRedactedWriter }>();
  private abortControllers = new Map<string, AbortController>();
  private authorizationTimers = new Map<string, NodeJS.Timeout>();
  private responderLeases = new Map<string, string>();
  private settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingSettlements = new Map<string, PendingSettlement>();
  private consumedResponderResults = new Map<string, ConsumedResponderResult>();
  private livenessWatchTimer: ReturnType<typeof setInterval> | undefined;
  private finalizations = new Map<string, Promise<boolean>>();
  private listeners = new Set<JobManagerListener>();
  /**
   * Tracks the first time a live job (with no ChildProcess handle) failed the
   * liveness check, so we only finalize it as "lost" after a sustained grace
   * window instead of on a single transient miss. Cleared as soon as the job is
   * observed alive again or finalized.
   */
  private livenessMisses = new Map<string, number>();
  private livenessCheckedAt = new Map<string, number>();
  private registryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly registryPath: string;
  private readonly transientV2RegistryPath: string;

  constructor(private readonly jobsDir = getJobsDir()) {
    this.registryPath = join(this.jobsDir, REGISTRY_FILE);
    this.transientV2RegistryPath = join(this.jobsDir, TRANSIENT_V2_REGISTRY_FILE);
    this.loadAndReconcile();
    this.sweepOrphanArtifacts();
  }

  private isDurable(job: BackgroundJob): boolean {
    return job.kind !== "ephemeral";
  }
  private artifactPathsOf(job: BackgroundJob): string[] {
    return [
      job.artifactPath,
      job.stdoutArtifact,
      job.stderrArtifact,
      ...(job.artifacts?.stdout.chunks ?? []),
      ...(job.artifacts?.stderr.chunks ?? []),
    ].filter((path): path is string => Boolean(path));
  }
  /** Delete a dropped job's artifact chunks, never one still referenced. */
  private removeJobArtifacts(job: BackgroundJob): void {
    const paths = this.artifactPathsOf(job).filter((path) =>
      path.startsWith(`${this.jobsDir}${sep}`),
    );
    if (paths.length === 0) return;
    const referenced = new Set<string>();
    for (const other of this.jobs.values()) {
      for (const path of this.artifactPathsOf(other)) referenced.add(path);
    }
    for (const path of new Set(paths)) {
      if (referenced.has(path)) continue;
      try {
        rmSync(path, { force: true });
      } catch {
        // Artifact cleanup is best-effort; a locked file is retried on boot.
      }
    }
  }
  /** Drop a job row plus its per-job caches and artifacts. */
  private forgetJob(id: string): void {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    for (const [notificationId, notification] of this.notifications) {
      if (notification.jobId === id) this.notifications.delete(notificationId);
    }
    this.consumedResponderResults.delete(id);
    this.livenessMisses.delete(id);
    this.livenessCheckedAt.delete(id);
    if (!job) return;
    forgetProcessIdentity(job.pid);
    this.removeJobArtifacts(job);
  }
  /** Remove artifact files whose job row no longer exists. */
  private sweepOrphanArtifacts(): void {
    let names: string[];
    try {
      names = readdirSync(this.jobsDir);
    } catch {
      return;
    }
    const known = new Set(this.jobs.keys());
    const now = Date.now();
    for (const name of names) {
      if (!/\.(stdout|stderr)\.log(\.\d+)?$/.test(name)) continue;
      if ([...known].some((id) => name.includes(`-${id}.`))) continue;
      const path = join(this.jobsDir, name);
      try {
        if (now - statSync(path).mtimeMs <= TERMINAL_JOB_MAX_AGE_MS) continue;
        rmSync(path, { force: true });
      } catch {
        // Ignore unreadable/locked leftovers.
      }
    }
  }

  private isLive(job: BackgroundJob): boolean {
    return (
      job.status === "running" ||
      job.status === "starting" ||
      job.status === "stopping"
    );
  }

  private isTerminalStatus(status: JobStatus): status is JobTerminalStatus {
    return status === "exited" || status === "failed" || status === "killed" || status === "lost";
  }

  private emit(change: JobManagerChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* listeners cannot break job persistence */ }
    }
  }

  subscribe(listener: JobManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private matchesSession(
    job: BackgroundJob,
    sessionId: string | undefined,
  ): boolean {
    if (!sessionId) return true;
    return job.ownerSessionId === sessionId;
  }

  private clearAuthorizationTimer(id: string): void {
    const timer = this.authorizationTimers.get(id);
    if (timer) clearTimeout(timer);
    this.authorizationTimers.delete(id);
  }

  private scheduleAuthorizationExpiry(job: BackgroundJob): void {
    this.clearAuthorizationTimer(job.id);
    const raw = job.authorization?.expiresAt;
    if (!raw || !this.isLive(job)) return;
    const expiresAt = Date.parse(raw);
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => {
      this.authorizationTimers.delete(job.id);
      this.refreshJobLiveness(job);
      if (this.isLive(job)) void this.stopJob(job.id, { graceMs: 1_000 });
    }, Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    this.authorizationTimers.set(job.id, timer);
  }

  activateResponderLease(sessionId: string): string {
    const current = this.responderLeases.get(sessionId);
    if (current) return current;
    const leaseId = randomUUID();
    this.responderLeases.set(sessionId, leaseId);
    this.emit({ type: "job", jobId: `responder:${sessionId}` });
    return leaseId;
  }

  getResponderLeaseId(sessionId: string | undefined): string | undefined {
    return sessionId ? this.responderLeases.get(sessionId) : undefined;
  }

  releaseResponderLease(sessionId: string, leaseId?: string): void {
    const current = this.responderLeases.get(sessionId);
    if (!current || (leaseId && current !== leaseId)) return;
    this.responderLeases.delete(sessionId);
    let changed = false;
    for (const notification of this.notifications.values()) {
      if (
        notification.ownerSessionId !== sessionId ||
        notification.responderLeaseId !== current
      ) {
        continue;
      }
      this.claimedNotifications.delete(notification.id);
      // Releasing a runtime lease must not discard an unread durable result;
      // detach it so the next lease for this session adopts it.
      if (!notification.acknowledgedAt && !notification.archivedAt) {
        delete notification.responderLeaseId;
        changed = true;
      }
    }
    if (changed && !this.persistSync()) this.scheduleRegistryRetry();
    this.emit({ type: "job", jobId: `responder:${sessionId}` });
  }

  private cloneReceipt(receipt: JobArtifactReceipt): JobArtifactReceipt {
    return { ...receipt, chunks: [...receipt.chunks] };
  }

  private notificationForJob(jobId: string): ResponderNotification | undefined {
    return [...this.notifications.values()].find((notification) => notification.jobId === jobId);
  }

  private ensureCompletionNotification(job: BackgroundJob): {
    notification?: ResponderNotification;
    created: boolean;
    updated: boolean;
  } {
    if (
      !this.isDurable(job) ||
      !this.isTerminalStatus(job.status) ||
      !job.responder
    ) {
      return { created: false, updated: false };
    }
    const existing = this.notificationForJob(job.id);
    const endedAt = job.endedAt ?? new Date().toISOString();
    const stdoutArtifact = this.cloneReceipt(job.artifacts.stdout);
    const stderrArtifact = this.cloneReceipt(job.artifacts.stderr);
    const completionChanged = Boolean(
      existing &&
        (existing.status !== job.status ||
          existing.endedAt !== endedAt ||
          existing.exitCode !== job.exitCode ||
          existing.signal !== job.signal ||
          JSON.stringify(existing.stdoutArtifact) !==
            JSON.stringify(stdoutArtifact) ||
          JSON.stringify(existing.stderrArtifact) !==
            JSON.stringify(stderrArtifact)),
    );
    const resultHash = createHash("sha256")
      .update(
        [
          job.status,
          endedAt,
          String(job.exitCode ?? ""),
          String(job.signal ?? ""),
          JSON.stringify(stdoutArtifact),
          JSON.stringify(stderrArtifact),
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 24);
    const consumed = this.consumedResponderResults.get(job.id);
    if (!existing && consumed?.resultHash === resultHash) {
      return { created: false, updated: false };
    }
    const correctsConsumed = Boolean(
      !existing && consumed && consumed.resultHash !== resultHash,
    );
    if (correctsConsumed) this.consumedResponderResults.delete(job.id);
    // A materially different authoritative result is a new revision: every
    // delivery/read/analysis marker belonged to the superseded result and must
    // not suppress review of the corrected one.
    const supersedes = Boolean(
      existing &&
        completionChanged &&
        (existing.resultHash === undefined || existing.resultHash !== resultHash),
    );
    const resultRevision = supersedes
      ? (existing?.resultRevision ?? 1) + 1
      : correctsConsumed
        ? (consumed?.resultRevision ?? 1) + 1
        : (existing?.resultRevision ?? 1);
    const supersededRevisions = supersedes && existing
      ? [
          ...(existing.supersededRevisions ?? []),
          {
            resultRevision: existing.resultRevision ?? 1,
            resultHash: existing.resultHash ?? "",
            status: existing.status,
            endedAt: existing.endedAt,
            ...(existing.exitCode !== undefined
              ? { exitCode: existing.exitCode }
              : {}),
            ...(existing.signal !== undefined ? { signal: existing.signal } : {}),
            ...(existing.deliveredAt ? { deliveredAt: existing.deliveredAt } : {}),
            ...(existing.readAt ? { readAt: existing.readAt } : {}),
            ...(existing.analyzedAt ? { analyzedAt: existing.analyzedAt } : {}),
            ...(existing.acknowledgedAt
              ? { acknowledgedAt: existing.acknowledgedAt }
              : {}),
            ...(existing.settledAt ? { settledAt: existing.settledAt } : {}),
          },
        ].slice(-MAX_SUPERSEDED_REVISIONS)
      : existing?.supersededRevisions;
    const carried = supersedes ? undefined : existing;
    const activeLeaseId = this.responderLeases.get(job.ownerSessionId);
    const responderLeaseId =
      activeLeaseId ?? job.responderLeaseId ?? existing?.responderLeaseId;
    const notification: ResponderNotification = {
      id:
        existing?.id ??
        `completion:${createHash("sha256").update(`${job.ownerSessionId}\0${job.id}\0${job.startedAt}`).digest("hex").slice(0, 24)}`,
      ownerSessionId: job.ownerSessionId,
      jobId: job.id,
      status: job.status,
      createdAt: existing?.createdAt ?? endedAt,
      startedAt: job.startedAt,
      endedAt,
      stdoutArtifact,
      stderrArtifact,
      commandDisplay: job.commandDisplay,
      wakeOnCompletion: job.wakeOnCompletion ?? false,
      responder: job.responder ?? false,
      ...(job.taskId ? { taskId: job.taskId } : {}),
      ...(job.parentTaskId ? { parentTaskId: job.parentTaskId } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.signal !== undefined ? { signal: job.signal } : {}),
      ...(job.monitor !== undefined ? { monitor: job.monitor } : {}),
      ...(responderLeaseId ? { responderLeaseId } : {}),
      resultRevision,
      resultHash,
      ...(supersededRevisions?.length ? { supersededRevisions } : {}),
      ...(carried?.deliveryStartedAt
        ? { deliveryStartedAt: carried.deliveryStartedAt }
        : {}),
      ...(carried?.deliveredAt ? { deliveredAt: carried.deliveredAt } : {}),
      ...(carried?.readAt ? { readAt: carried.readAt } : {}),
      ...((carried?.analyzedAt ?? carried?.acknowledgedAt)
        ? { analyzedAt: carried?.analyzedAt ?? carried?.acknowledgedAt }
        : {}),
      ...(carried?.acknowledgedAt
        ? { acknowledgedAt: carried.acknowledgedAt }
        : {}),
      ...(carried?.settledAt ? { settledAt: carried.settledAt } : {}),
      ...(carried?.discardedAt
        ? {
            discardedAt: carried.discardedAt,
            ...(carried.discardReason
              ? { discardReason: carried.discardReason }
              : {}),
            wakeOnCompletion: false,
          }
        : {}),
      ...(carried?.archivedAt ? { archivedAt: carried.archivedAt } : {}),
    };
    if (supersedes) this.claimedNotifications.delete(notification.id);
    const updated = Boolean(
      existing && JSON.stringify(existing) !== JSON.stringify(notification),
    );
    this.notifications.set(notification.id, notification);
    return { notification, created: !existing, updated };
  }

  private async closeWriters(id: string): Promise<boolean> {
    const writers = this.writers.get(id);
    if (!writers) return true;
    const results = await Promise.allSettled([writers.stdout.close(), writers.stderr.close()]);
    this.writers.delete(id);
    return results.every((result) => result.status === "fulfilled");
  }

  private async finalizeJob(
    job: BackgroundJob,
    status: JobTerminalStatus,
    details: { exitCode?: number | undefined; signal?: string | undefined; endedAt?: string | undefined } = {},
  ): Promise<boolean> {
    const pending = this.finalizations.get(job.id);
    if (pending) return pending;
    const correctsLost = job.status === "lost" && status !== "lost";
    if (this.isTerminalStatus(job.status) && !correctsLost) {
      const completion = this.ensureCompletionNotification(job);
      this.scheduleTaskSettlement(job);
      if (
        (!completion.created && !completion.updated) ||
        !completion.notification
      ) {
        return true;
      }
      const persisted = this.persistSync();
      if (!persisted) this.scheduleRegistryRetry();
      this.emit({ type: "job", jobId: job.id });
      this.emit({
        type: "notification",
        jobId: job.id,
        notificationId: completion.notification.id,
      });
      return persisted;
    }
    const finalization = (async (): Promise<boolean> => {
      this.clearAuthorizationTimer(job.id);
      this.livenessMisses.delete(job.id);
      const streamsFlushed = await this.closeWriters(job.id);
      job.status = streamsFlushed ? status : "failed";
      if (details.exitCode !== undefined) job.exitCode = details.exitCode;
      if (!streamsFlushed && (job.exitCode === undefined || job.exitCode === 0)) {
        job.exitCode = 1;
      }
      if (details.signal !== undefined) job.signal = details.signal;
      job.endedAt = details.endedAt ?? new Date().toISOString();
      this.abortControllers.delete(job.id);
      this.processes.delete(job.id);
      const completion = this.ensureCompletionNotification(job);
      this.scheduleTaskSettlement(job);
      this.pruneTerminalJobs();
      const persisted = this.persistSync();
      if (!persisted) this.scheduleRegistryRetry();
      this.emit({ type: "job", jobId: job.id });
      if (
        (completion.created || completion.updated) &&
        completion.notification
      ) {
        this.emit({
          type: "notification",
          jobId: job.id,
          notificationId: completion.notification.id,
        });
      }
      return persisted;
    })();
    this.finalizations.set(job.id, finalization);
    try {
      return await finalization;
    } finally {
      this.finalizations.delete(job.id);
    }
  }

  /** Reconcile a restored process that no longer has a ChildProcess close event. */
  private refreshJobLiveness(
    job: BackgroundJob,
    options: { force?: boolean } = {},
  ): void {
    if (!this.isLive(job) || this.processes.has(job.id)) {
      this.livenessMisses.delete(job.id);
      this.livenessCheckedAt.delete(job.id);
      return;
    }
    // Subscribers can ask for state many times per frame; one probe per job per
    // interval is enough because the lost grace window is far longer.
    const checkedAt = this.livenessCheckedAt.get(job.id);
    const probeAt = Date.now();
    if (
      !options.force &&
      checkedAt !== undefined &&
      probeAt - checkedAt < LIVENESS_PROBE_INTERVAL_MS
    ) {
      return;
    }
    this.livenessCheckedAt.set(job.id, probeAt);
    // Primary signal is the pid itself. If the process is alive we keep the job
    // running and only ever declare "lost" on a PROVEN pid reuse (both the
    // stored and the current identity are present AND differ). An identity read
    // that fails or returns nothing is "unknown", never "dead" — treating it as
    // dead is exactly what flipped live jobs to lost mid-run.
    if (processAlive(job.pid)) {
      const identity = processIdentity(job.pid);
      const provenReuse = Boolean(
        identity && job.processIdentity && identity !== job.processIdentity,
      );
      if (!provenReuse) {
        this.livenessMisses.delete(job.id);
        return;
      }
    } else {
      forgetProcessIdentity(job.pid);
    }
    // The process looks gone (or is a proven pid reuse). Require the miss to
    // persist across a grace window before finalizing — a single transient
    // hiccup must not kill a job whose real close event is still in flight.
    const nowMs = Date.now();
    const firstMiss = this.livenessMisses.get(job.id);
    if (firstMiss === undefined) {
      this.livenessMisses.set(job.id, nowMs);
      return;
    }
    if (nowMs - firstMiss < LIVENESS_LOST_GRACE_MS) return;
    this.livenessMisses.delete(job.id);
    job.status = "lost";
    job.endedAt = new Date().toISOString();
    this.clearAuthorizationTimer(job.id);
    const completion = this.ensureCompletionNotification(job);
    this.scheduleTaskSettlement(job);
    this.pruneTerminalJobs();
    if (!this.persistSync()) this.scheduleRegistryRetry();
    this.emit({ type: "job", jobId: job.id });
    if (
      (completion.created || completion.updated) &&
      completion.notification
    ) {
      this.emit({
        type: "notification",
        jobId: job.id,
        notificationId: completion.notification.id,
      });
    }
  }

  private scheduleTaskSettlement(job: BackgroundJob, delayMs = 0): void {
    if (!job.responder || !job.taskId || !this.isTerminalStatus(job.status)) return;
    const existing = this.settlementTimers.get(job.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.settlementTimers.delete(job.id);
      const revision = this.notificationForJob(job.id)?.resultRevision ?? 1;
      void import("../store/responder-settlement.js")
        .then(({ settleResponderJob }) =>
          settleResponderJob({ ...job }, { resultRevision: revision }),
        )
        .then((result) => {
          if (result === "applied" || result === "noop") {
            this.completeSettlement(job.id, revision);
            return;
          }
          this.retrySettlement(job, revision, result);
        })
        .catch((error: unknown) => {
          this.retrySettlement(
            job,
            revision,
            error instanceof Error ? error.message : String(error),
          );
        });
    }, delayMs);
    timer.unref?.();
    this.settlementTimers.set(job.id, timer);
  }

  private completeSettlement(jobId: string, resultRevision: number): void {
    this.pendingSettlements.delete(jobId);
    const notification = this.notificationForJob(jobId);
    if (
      !notification ||
      (notification.resultRevision ?? 1) !== resultRevision ||
      notification.settledAt
    ) {
      if (!this.persistSync()) this.scheduleRegistryRetry();
      return;
    }
    notification.settledAt = new Date().toISOString();
    if (!this.persistSync()) this.scheduleRegistryRetry();
    this.emit({
      type: "notification",
      jobId,
      notificationId: notification.id,
    });
  }

  /**
   * Retry until the projection lands. The marker is durable, so a crash or a
   * long-lived plan-write conflict cannot silently strand a green child, and an
   * unrecoverable case is dead-lettered with a visible reason.
   */
  private retrySettlement(
    job: BackgroundJob,
    resultRevision: number,
    reason: string,
  ): void {
    const now = new Date().toISOString();
    const previous = this.pendingSettlements.get(job.id);
    const carryOver =
      previous && previous.resultRevision === resultRevision ? previous : undefined;
    const attempts = (carryOver?.attempts ?? 0) + 1;
    const firstAttemptAt = carryOver?.firstAttemptAt ?? now;
    const elapsed = Date.now() - Date.parse(firstAttemptAt);
    const deadLettered =
      Number.isFinite(elapsed) && elapsed > SETTLEMENT_DEAD_LETTER_MS;
    this.pendingSettlements.set(job.id, {
      jobId: job.id,
      resultRevision,
      attempts,
      firstAttemptAt,
      lastAttemptAt: now,
      lastReason: reason,
      ...(deadLettered ? { deadLetteredAt: now } : {}),
    });
    if (!this.persistSync()) this.scheduleRegistryRetry();
    this.emit({ type: "job", jobId: job.id });
    if (deadLettered) return;
    this.scheduleTaskSettlement(
      job,
      Math.min(SETTLEMENT_MAX_BACKOFF_MS, 50 * 2 ** Math.min(attempts, 10)),
    );
  }

  /**
   * One coalesced, unref'd watcher that reconciles restored live jobs without a
   * UI read. Without it a headless session can leave a finished responder job
   * "running" forever, because liveness was only refreshed by list/get calls.
   */
  private scheduleLivenessWatch(): void {
    if (this.livenessWatchTimer) return;
    const restored = [...this.jobs.values()].filter(
      (job) => this.isDurable(job) && this.isLive(job) && !this.processes.has(job.id),
    );
    if (restored.length === 0) return;
    const timer = setInterval(() => {
      const pending = [...this.jobs.values()].filter(
        (job) => this.isDurable(job) && this.isLive(job) && !this.processes.has(job.id),
      );
      for (const job of pending) this.refreshJobLiveness(job);
      const remaining = [...this.jobs.values()].some(
        (job) => this.isDurable(job) && this.isLive(job) && !this.processes.has(job.id),
      );
      if (remaining) return;
      clearInterval(timer);
      this.livenessWatchTimer = undefined;
    }, LIVENESS_WATCH_INTERVAL_MS);
    timer.unref?.();
    this.livenessWatchTimer = timer;
  }

  /** Ownership guard: a receipt may only be mutated by its owning session. */
  private ownsNotification(
    notification: ResponderNotification | undefined,
    sessionId: string | undefined,
  ): notification is ResponderNotification {
    if (!notification) return false;
    return sessionId === undefined || notification.ownerSessionId === sessionId;
  }

  /** Receipt for a launch that was deduplicated by its delegation key. */
  private startJobReceipt(job: BackgroundJob, reason: string): ToolResult {
    return {
      ok: true,
      output:
        `Reusing background job id=${job.id} (${reason}) pid=${job.pid ?? "?"} status=${job.status}\n` +
        `Command: ${job.commandDisplay}\nArtifact: ${job.stdoutArtifact}\n` +
        `The duplicate launch was not started. ${launchFollowUp(job.id, job.responder === true)}`,
      outputPath: job.stdoutArtifact,
      backgroundJob: {
        id: job.id,
        status: job.status,
        artifactPath: job.stdoutArtifact,
        ...(job.responder ? { responder: true } : {}),
        nextOffset: 0,
      },
    };
  }

  /** Terminal results whose plan child could not be settled yet. */
  getPendingSettlements(): PendingSettlement[] {
    return [...this.pendingSettlements.values()];
  }

  /**
   * Register an in-flight tool for stall tracking only.
   * Never appears in shell.jobs and never touches the durable registry.
   */
  registerJob(id: string, job: BackgroundJob, ac?: AbortController, child?: ChildProcess): void {
    const tracked: BackgroundJob = { ...job, kind: job.kind ?? "ephemeral" };
    this.jobs.set(id, tracked);
    if (ac) this.abortControllers.set(id, ac);
    if (child) this.processes.set(id, child);
    if (this.isDurable(tracked)) this.persistSync();
    this.emit({ type: "job", jobId: id });
  }

  updateJobStatus(id: string, status: JobStatus, exitCode?: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (this.isDurable(job) && this.isTerminalStatus(status)) {
      void this.finalizeJob(job, status, { ...(exitCode !== undefined ? { exitCode } : {}) });
      return;
    }
    job.status = status;
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (!this.isLive(job)) job.endedAt = new Date().toISOString();
    this.abortControllers.delete(id);
    this.processes.delete(id);
    if (!this.isLive(job)) this.clearAuthorizationTimer(id);
    if (!this.isDurable(job) && !this.isLive(job)) {
      this.forgetJob(id);
      this.emit({ type: "job", jobId: id });
      return;
    }
    if (this.isDurable(job)) {
      this.pruneTerminalJobs();
      this.persistSync();
    }
    this.emit({ type: "job", jobId: id });
  }

  async startJob(command: string | BackgroundSpawnSpec, options?: StartJobOptions): Promise<ToolResult> {
    if (options?.authorization?.expiresAt) {
      const expiry = Date.parse(options.authorization.expiresAt);
      if (Number.isFinite(expiry) && expiry <= Date.now()) {
        return { ok: false, output: `Engagement authorization for ${options.authorization.target} has expired.`, exitCode: 1 };
      }
    }
    if (options?.delegationId) {
      // A retried tool call must not spawn a second scanner: the delegation key
      // identifies the work, so the existing job is returned unchanged.
      const existing = [...this.jobs.values()].find(
        (candidate) =>
          candidate.delegationId === options.delegationId &&
          candidate.ownerSessionId === (options.ownerSessionId ?? "unknown"),
      );
      if (existing) return this.startJobReceipt(existing, "existing delegation");
    }
    const id = randomUUID().slice(0, 8);
    const cwd = options?.cwd ?? safeCwd();
    try {
      const cwdStat = await stat(cwd);
      if (!cwdStat.isDirectory()) {
        return {
          ok: false,
          output:
            `Background command launch error [INVALID_CWD]: working directory is not a directory.\n` +
            `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct shell.start cwd instead of changing command syntax.`,
          exitCode: 127,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output:
          `Background command launch error [INVALID_CWD]: ${error instanceof Error ? error.message : String(error)}\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct shell.start cwd instead of changing command syntax.`,
        exitCode: 127,
      };
    }
    const shell = typeof command === "string" ? resolveShell() : undefined;
    if (typeof command === "string" && !shell) {
      return {
        ok: false,
        output:
          `Background command launch error [SHELL_NOT_FOUND]: no usable command shell was found.\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start.`,
        exitCode: 127,
      };
    }
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    const prefix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`;
    const stdoutArtifact = join(this.jobsDir, `${prefix}.stdout.log`);
    const stderrArtifact = join(this.jobsDir, `${prefix}.stderr.log`);
    const makeReceipt = (path: string): JobArtifactReceipt => ({ path, chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" });
    const safeDisplay = redactSecrets(commandDisplay(command));
    const monitor = options?.monitor !== undefined || options?.profile !== undefined || options?.estimatedSeconds !== undefined
      ? {
          ...(options?.monitor ?? {}),
          ...(options?.profile !== undefined ? { profile: options.profile } : {}),
          ...(options?.estimatedSeconds !== undefined ? { estimatedSeconds: options.estimatedSeconds } : {}),
        }
      : undefined;
    const job: BackgroundJob = {
      id,
      command: safeDisplay,
      commandDisplay: safeDisplay,
      cwd,
      status: "starting",
      startedAt: new Date().toISOString(),
      artifactPath: stdoutArtifact,
      stdoutArtifact,
      stderrArtifact,
      artifacts: { stdout: makeReceipt(stdoutArtifact), stderr: makeReceipt(stderrArtifact) },
      redactionProfile: "provider-secrets-v1",
      ownerSessionId: options?.ownerSessionId ?? "unknown",
      kind: "durable",
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
      ...(options?.delegationId ? { delegationId: options.delegationId } : {}),
      ...(options?.wakeOnCompletion !== undefined ? { wakeOnCompletion: options.wakeOnCompletion } : {}),
      ...(options?.responder !== undefined ? { responder: options.responder } : {}),
      ...(monitor !== undefined ? { monitor } : {}),
      ...(options?.responderLeaseId
        ? { responderLeaseId: options.responderLeaseId }
        : {}),
      ...(options?.authorization ? { authorization: options.authorization } : {}),
    };
    this.jobs.set(id, job);
    this.pruneTerminalJobs();
    try {
      await this.persist();
    } catch {
      this.forgetJob(id);
      return {
        ok: false,
        output: "Background command launch error [PERSIST_FAILED]: could not persist the job registry; the command was not started.",
        exitCode: 1,
      };
    }
    this.emit({ type: "job", jobId: id });

    let launchConfirmed = false;
    try {
      const detached = process.platform !== "win32";
      const spawnChild = (): ChildProcess =>
        typeof command === "string"
          ? spawn(command, {
              cwd,
              detached,
              shell: shell!,
              stdio: ["ignore", "pipe", "pipe"],
            })
          : spawn(command.command, command.argv, {
              cwd,
              detached,
              shell: false,
              stdio: [command.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            });
      let child = spawnChild();
      const stdout = new RotatingRedactedWriter(job.artifacts.stdout);
      const stderr = new RotatingRedactedWriter(job.artifacts.stderr);
      this.writers.set(id, { stdout, stderr });
      stdout.append(`$ ${job.commandDisplay}\n\n`);

      // A ChildProcess object is returned before the OS confirms launch. Wait
      // for `spawn` (or `error`) so shell.start never reports a phantom running
      // job whose pid is absent and whose eventual status is opaque exit=-2.
      const waitForLaunch = (
        candidate: ChildProcess,
      ): Promise<NodeJS.ErrnoException | undefined> =>
        new Promise((resolve) => {
          const onSpawn = (): void => {
            candidate.off("error", onError);
            resolve(undefined);
          };
          const onError = (error: Error): void => {
            candidate.off("spawn", onSpawn);
            resolve(error as NodeJS.ErrnoException);
          };
          candidate.once("spawn", onSpawn);
          candidate.once("error", onError);
        });
      let launchError = await waitForLaunch(child);
      let launchRetried = false;
      if (
        launchError?.code === "ENOENT" &&
        typeof command === "string" &&
        existsSync(shell!) &&
        existsSync(cwd)
      ) {
        // Safe: the first child never started, so no command side effects are
        // duplicated. Own this transient retry in the runtime, not the model.
        launchRetried = true;
        await new Promise((resolve) => setTimeout(resolve, 75));
        child = spawnChild();
        launchError = await waitForLaunch(child);
      }
      if (launchError) {
        const target = typeof command === "string" ? shell! : command.command;
        const code = launchError.code ?? "UNKNOWN";
        const fields = [
          `target=${JSON.stringify(target)}`,
          `cwd=${JSON.stringify(cwd)}`,
          launchError.syscall ? `syscall=${JSON.stringify(launchError.syscall)}` : undefined,
          launchError.path ? `path=${JSON.stringify(launchError.path)}` : undefined,
        ].filter((value): value is string => Boolean(value));
        const ownership = job.responder
          ? "Responder owns this terminal launch failure; do not poll or retry it. Its result will be delivered automatically."
          : "Inspect the failed job receipt before deciding whether changed evidence supports a retry.";
        const detail =
          `${launchRetried ? "Automatic retry after a transient launch ENOENT also failed.\n" : ""}` +
          `Background command launch error [${code}]: ${launchError.message}\n` +
          `${fields.join("; ")}\n` +
          "The command did not start. Do not rewrite its syntax to work around this infrastructure error; verify the target and cwd.\n" +
          ownership;
        stderr.append(`${detail}\n`);
        await this.finalizeJob(job, "failed", { exitCode: 127 });
        return {
          ok: false,
          output: detail,
          exitCode: 127,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: "failed",
            exitCode: 127,
            artifactPath: stdoutArtifact,
            ...(job.responder ? { responder: true } : {}),
            nextOffset: 0,
          },
        };
      }
      launchConfirmed = true;

      // Sensitive input is never copied into the job record, display, logs, or
      // artifacts. Write it once only after launch has been confirmed.
      if (typeof command !== "string" && command.stdinText !== undefined) {
        child.stdin?.end(command.stdinText);
      }
      job.pid = child.pid;
      job.processGroupId = detached ? child.pid : undefined;
      job.status = "running";
      job.heartbeatAt = new Date().toISOString();
      job.processIdentity = processIdentity(child.pid, { refresh: true });
      this.processes.set(id, child);
      this.writers.set(id, { stdout, stderr });
      this.scheduleAuthorizationExpiry(job);
      let lastProgressFlush = 0;
      let lastDurableFlush = Date.now();
      let progressDirty = false;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      // UI freshness is cheap; rewriting the whole registry is not. Terminal
      // transitions always persist authoritatively below.
      const flushProgress = (): void => {
        progressDirty = false;
        lastProgressFlush = Date.now();
        if (lastProgressFlush - lastDurableFlush >= DURABLE_PROGRESS_FLUSH_MS) {
          lastDurableFlush = lastProgressFlush;
          this.persistSync();
        }
        this.emit({ type: "job", jobId: id });
      };
      // Coalesce high-frequency stdout/stderr chunks: a chatty job (scanner,
      // dev server) must not force a registry write + UI rerender per data
      // event. Flush at most every PROGRESS_FLUSH_MS, with a trailing flush so
      // the last chunk before a quiet gap is never dropped. Terminal
      // finalize/close always persists authoritatively and clears the timer.
      const scheduleProgressFlush = (): void => {
        const elapsed = Date.now() - lastProgressFlush;
        if (elapsed >= PROGRESS_FLUSH_MS) {
          if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = undefined;
          }
          flushProgress();
          return;
        }
        progressDirty = true;
        if (progressTimer) return;
        progressTimer = setTimeout(() => {
          progressTimer = undefined;
          if (progressDirty) flushProgress();
        }, PROGRESS_FLUSH_MS - elapsed);
        progressTimer.unref?.();
      };
      const stopProgressFlush = (): void => {
        if (progressTimer) {
          clearTimeout(progressTimer);
          progressTimer = undefined;
        }
        progressDirty = false;
      };
      const recordOutput = (
        writer: RotatingRedactedWriter,
        source: Readable,
        chunk: Buffer,
      ): void => {
        const writable = writer.append(chunk);
        if (!writable) {
          source.pause();
          void writer.waitForDrain().then(() => {
            if (this.isLive(job) && !source.destroyed) source.resume();
          });
        }
        job.heartbeatAt = new Date().toISOString();
        scheduleProgressFlush();
      };
      child.stdout?.on("data", (chunk: Buffer) =>
        recordOutput(stdout, child.stdout!, chunk),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        recordOutput(stderr, child.stderr!, chunk),
      );
      child.on("close", (code, signal) => {
        stopProgressFlush();
        const status: JobTerminalStatus = signal ? "killed" : code === 0 ? "exited" : "failed";
        void this.finalizeJob(job, status, {
          ...(code !== null ? { exitCode: code } : {}),
          ...(signal !== null ? { signal } : {}),
        });
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        stopProgressFlush();
        const code = error.code ?? "UNKNOWN";
        try { stderr.append(`Background process error [${code}]: ${error.message}\n`); } catch { /* finalization already owns the writers */ }
        void this.finalizeJob(job, "failed", { exitCode: 127 });
      });
      this.persistSync();
      this.emit({ type: "job", jobId: id });

      // Best-effort detection for shell-level failures such as command-not-found
      // immediately after the command shell launches. This bounded window is
      // not an application readiness guarantee; callers must tail/probe.
      let closedEarly = false;
      await new Promise<void>((resolve) => {
        if (!this.isLive(job)) {
          resolve();
          return;
        }
        const onClose = (): void => {
          closedEarly = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          child.off("close", onClose);
          resolve();
        }, 30);
        child.once("close", onClose);
      });
      if (closedEarly) {
        const finalization = this.finalizations.get(id);
        if (finalization) await finalization;
      }
      const earlyStatus = this.getJob(id)?.status;
      if (earlyStatus === "failed") {
        await this.persist();
        const failureFollowUp = job.responder
          ? "Responder owns this terminal failure; do not poll or retry it. Its result will be delivered automatically."
          : `Use shell.tail {"id":"${id}"} for captured stderr; do not retry unchanged.`;
        return {
          ok: false,
          output:
            `Background job failed immediately: id=${id} exit=${job.exitCode ?? "?"}\n` +
            `Command: ${job.commandDisplay}\n${failureFollowUp}`,
          exitCode: job.exitCode ?? 1,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: "failed",
            exitCode: job.exitCode,
            artifactPath: stdoutArtifact,
            ...(job.responder ? { responder: true } : {}),
            nextOffset: 0,
          },
        };
      }

      child.unref();
      await this.persist();
      return {
        ok: true,
        output:
          `OS process launch confirmed: id=${id} (canonical job ID) pid=${child.pid ?? "?"}\n` +
          `Command: ${job.commandDisplay}\nArtifact: ${stdoutArtifact}\n` +
          launchFollowUp(id, job.responder === true),
        outputPath: stdoutArtifact,
        backgroundJob: {
          id,
          status: job.status,
          artifactPath: stdoutArtifact,
          ...(job.responder ? { responder: true } : {}),
          ...(options?.profile ? { profile: options.profile } : {}),
          ...(options?.estimatedSeconds !== undefined ? { estimatedSeconds: options.estimatedSeconds } : {}),
          nextOffset: 0,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (launchConfirmed) {
        const alive = processAlive(job.pid);
        if (!alive && this.isLive(job)) {
          await this.finalizeJob(job, "failed", { exitCode: job.exitCode ?? 1 });
        } else if (alive) {
          job.status = "running";
          this.persistSync();
          this.emit({ type: "job", jobId: id });
        }
        const followUp = launchFollowUp(id, job.responder === true);
        return {
          ok: alive,
          output:
            `Background command launched as pid=${job.pid ?? "?"}, but job setup/persistence failed: ${detail}\n` +
            `${alive ? `The process is still running as job ${id}; do not launch a duplicate. ` : "The process has already stopped. "}` +
            followUp,
          exitCode: alive ? undefined : job.exitCode,
          outputPath: stdoutArtifact,
          backgroundJob: {
            id,
            status: job.status,
            exitCode: job.exitCode,
            artifactPath: stdoutArtifact,
            ...(job.responder ? { responder: true } : {}),
            nextOffset: 0,
          },
        };
      }
      await this.finalizeJob(job, "failed", { exitCode: 127 });
      return {
        ok: false,
        output:
          `Background command launch error [UNKNOWN]: ${detail}\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start.\n` +
          launchFollowUp(id, job.responder === true),
        exitCode: 127,
        outputPath: stdoutArtifact,
        backgroundJob: {
          id,
          status: "failed",
          exitCode: 127,
          artifactPath: stdoutArtifact,
          ...(job.responder ? { responder: true } : {}),
          nextOffset: 0,
        },
      };
    }
  }

  /**
   * List durable background jobs for this session only.
   * Ephemeral tool-stall rows and other sessions' jobs are excluded.
   */
  listJobs(sessionId?: string): ToolResult {
    this.pruneTerminalJobs();
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    const durable = [...this.jobs.values()].filter(
      (job) => this.isDurable(job) && this.matchesSession(job, sessionId),
    );
    if (durable.length === 0) {
      return {
        ok: true,
        output: sessionId
          ? `No background jobs for this session (${sessionId}).`
          : "No background jobs.",
      };
    }
    const live = durable
      .filter((j) => this.isLive(j))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const done = durable
      .filter((j) => !this.isLive(j))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const ordered = [...live, ...done];
    const shown = ordered.slice(0, LIST_JOBS_MAX_LINES);
    // Judge on every job in scope, not just the display window: a normal job
    // pushed past the window must still keep shell.jobs answerable.
    const pollingPolicy = responderPollingPolicy({
      call: { name: "shell.jobs", args: {} },
      recentJobs: ordered,
    });
    if (pollingPolicy.blocked) {
      return {
        ok: true,
        output:
          pollingPolicy.reason ??
          "shell.jobs was not dispatched because Responder owns the running jobs.",
        exitCode: 0,
        suppressedRepeat: true,
      };
    }
    const omitted = ordered.length - shown.length;
    const format = (job: BackgroundJob): string => {
      const health = this.isLive(job)
        ? processAlive(job.pid)
          ? "alive"
          : "unresponsive"
        : "terminal";
      const notification = this.notificationForJob(job.id);
      const receipt = notification
        ? notification.acknowledgedAt
          ? "consumed"
          : notification.analyzedAt
            ? "analyzed"
            : notification.readAt
              ? "read"
              : notification.deliveredAt
                ? "delivered-unread"
                : notification.deliveryStartedAt
                  ? "delivering"
                  : "ready"
        : this.consumedResponderResults.has(job.id)
          ? "consumed"
          : job.responder
            ? this.isLive(job)
              ? "running"
              : "pending"
            : undefined;
      return `[${job.id}] ${job.status} health=${health} exit=${job.exitCode ?? "?"}${receipt ? ` responder=${receipt}` : ""} ${formatJobElapsed(job)}  ${job.commandDisplay.slice(0, 80)}`;
    };
    const header = sessionId
      ? `Session background jobs (${durable.length} total, session ${sessionId}):`
      : `Background jobs (${durable.length} total):`;
    const lines = [header, ...shown.map(format)];
    if (omitted > 0) {
      lines.push(
        `… ${omitted} older terminal job(s) omitted — use shell.tail with a known id if needed.`,
      );
    }
    if (live.length === 0) {
      lines.push("None currently running.");
    }
    return { ok: true, output: lines.join("\n") };
  }

  private resolveJobId(input: string): string | undefined {
    if (this.jobs.has(input)) return input;
    const inputBase = basename(input);
    for (const job of this.jobs.values()) {
      const artifacts = [
        job.artifactPath,
        job.stdoutArtifact,
        job.stderrArtifact,
        ...job.artifacts.stdout.chunks,
        ...job.artifacts.stderr.chunks,
      ];
      if (
        artifacts.some((path) => input === path || inputBase === basename(path)) ||
        inputBase.includes(`-${job.id}.`)
      ) {
        return job.id;
      }
    }
    return undefined;
  }

  getJob(id: string): BackgroundJob | undefined {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (job) this.refreshJobLiveness(job);
    return job;
  }

  getPendingNotifications(sessionId?: string): ResponderNotification[] {
    return [...this.notifications.values()]
      .filter((notification) =>
        !notification.acknowledgedAt &&
        !notification.discardedAt &&
        (!sessionId || notification.ownerSessionId === sessionId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pendingNotifications(sessionId?: string): ResponderNotification[] {
    return this.getPendingNotifications(sessionId);
  }

  claimNextResponderNotification(
    sessionId: string,
    leaseId: string,
  ): ResponderNotification | undefined {
    if (this.responderLeases.get(sessionId) !== leaseId) return undefined;
    let adopted = false;
    for (const notification of this.notifications.values()) {
      // Receipts belong to the session, not to a runtime lease: a new lease
      // adopts everything unread that an earlier lease left behind.
      if (
        notification.ownerSessionId === sessionId &&
        !notification.acknowledgedAt &&
        !notification.archivedAt &&
        !notification.discardedAt &&
        notification.responderLeaseId !== leaseId
      ) {
        notification.responderLeaseId = leaseId;
        adopted = true;
      }
    }
    const notification = [...this.notifications.values()]
      .filter(
        (candidate) =>
          candidate.ownerSessionId === sessionId &&
          candidate.responderLeaseId === leaseId &&
          !candidate.archivedAt &&
          !candidate.discardedAt &&
          !candidate.readAt &&
          !candidate.analyzedAt &&
          !candidate.acknowledgedAt &&
          !this.claimedNotifications.has(candidate.id),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (notification) this.claimedNotifications.add(notification.id);
    if (adopted && !this.persistSync()) this.scheduleRegistryRetry();
    return notification;
  }

  releaseResponderNotificationClaim(notificationId: string): void {
    this.claimedNotifications.delete(notificationId);
  }

  /**
   * Record that a delivery attempt started. This is deliberately weaker than
   * `markDelivered`: an aborted or failed analysis turn must remain deliverable.
   */
  markDeliveryStarted(notificationId: string, sessionId?: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!this.ownsNotification(notification, sessionId)) return false;
    if (notification.deliveryStartedAt) return true;
    notification.deliveryStartedAt = new Date().toISOString();
    if (!this.persistSync()) {
      notification.deliveryStartedAt = undefined;
      return false;
    }
    this.emit({
      type: "notification",
      jobId: notification.jobId,
      notificationId,
    });
    return true;
  }

  markDelivered(notificationId: string, sessionId?: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!this.ownsNotification(notification, sessionId)) return false;
    if (!notification.deliveredAt) {
      notification.deliveredAt = new Date().toISOString();
      notification.deliveryStartedAt ??= notification.deliveredAt;
      if (!this.persistSync()) {
        notification.deliveredAt = undefined;
        return false;
      }
      this.emit({ type: "notification", jobId: notification.jobId, notificationId });
    }
    if (
      notification.readAt ||
      notification.analyzedAt ||
      notification.acknowledgedAt
    ) {
      this.claimedNotifications.delete(notificationId);
    }
    return true;
  }

  markRead(notificationId: string, sessionId: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (
      !notification ||
      notification.ownerSessionId !== sessionId ||
      !notification.responder ||
      notification.archivedAt ||
      notification.discardedAt
    ) {
      return false;
    }
    const previousDeliveredAt = notification.deliveredAt;
    const previousReadAt = notification.readAt;
    const readAt = new Date().toISOString();
    notification.deliveredAt ??= readAt;
    notification.readAt ??= readAt;
    if (!this.persistSync()) {
      notification.deliveredAt = previousDeliveredAt;
      notification.readAt = previousReadAt;
      return false;
    }
    this.claimedNotifications.delete(notificationId);
    this.emit({
      type: "notification",
      jobId: notification.jobId,
      notificationId,
    });
    return true;
  }

  markAnalyzed(notificationId: string, sessionId?: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!notification || !this.ownsNotification(notification, sessionId)) {
      return false;
    }
    if (!notification.deliveredAt && !notification.deliveryStartedAt) {
      return false;
    }
    this.claimedNotifications.delete(notificationId);
    if (!notification.analyzedAt) {
      notification.analyzedAt = new Date().toISOString();
      if (!this.persistSync()) this.scheduleRegistryRetry();
      this.emit({
        type: "notification",
        jobId: notification.jobId,
        notificationId,
      });
    }
    return true;
  }

  acknowledge(notificationId: string, sessionId?: string): boolean {
    const notification = this.notifications.get(notificationId);
    if (!notification || !this.ownsNotification(notification, sessionId)) {
      return false;
    }
    if (!notification.analyzedAt) return false;
    this.claimedNotifications.delete(notificationId);
    if (!notification.acknowledgedAt) {
      notification.acknowledgedAt = new Date().toISOString();
      this.consumedResponderResults.set(notification.jobId, {
        jobId: notification.jobId,
        resultHash: notification.resultHash ?? "",
        resultRevision: notification.resultRevision ?? 1,
        acknowledgedAt: notification.acknowledgedAt,
      });
      const persisted = this.persistSync();
      if (!persisted) this.scheduleRegistryRetry();
      if (persisted) {
        this.pruneTerminalJobs();
        this.persistSync();
      }
      this.emit({ type: "notification", jobId: notification.jobId, notificationId });
    }
    return true;
  }

  linkJob(jobId: string, metadata: JobLinkMetadata): BackgroundJob | undefined {
    const resolved = this.resolveJobId(jobId);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job || !this.isDurable(job)) return undefined;
    const previousJob: JobLinkMetadata = {
      taskId: job.taskId,
      parentTaskId: job.parentTaskId,
      wakeOnCompletion: job.wakeOnCompletion,
      monitor: job.monitor,
      responder: job.responder,
    };
    const existingNotification = this.notificationForJob(job.id);
    const previousNotification = existingNotification
      ? {
          taskId: existingNotification.taskId,
          parentTaskId: existingNotification.parentTaskId,
          wakeOnCompletion: existingNotification.wakeOnCompletion,
          monitor: existingNotification.monitor,
          responder: existingNotification.responder,
        }
      : undefined;
    if (metadata.taskId !== undefined) job.taskId = metadata.taskId;
    if (metadata.parentTaskId !== undefined) job.parentTaskId = metadata.parentTaskId;
    if (metadata.wakeOnCompletion !== undefined) job.wakeOnCompletion = metadata.wakeOnCompletion;
    if (metadata.monitor !== undefined) job.monitor = metadata.monitor;
    if (metadata.responder !== undefined) job.responder = metadata.responder;
    const completion = this.ensureCompletionNotification(job);
    this.scheduleTaskSettlement(job);
    if (completion.notification) {
      if (metadata.taskId !== undefined) completion.notification.taskId = metadata.taskId;
      if (metadata.parentTaskId !== undefined) completion.notification.parentTaskId = metadata.parentTaskId;
      if (metadata.wakeOnCompletion !== undefined) completion.notification.wakeOnCompletion = metadata.wakeOnCompletion;
      if (metadata.monitor !== undefined) completion.notification.monitor = metadata.monitor;
      if (metadata.responder !== undefined) completion.notification.responder = metadata.responder;
    }
    if (!this.persistSync()) {
      job.taskId = previousJob.taskId;
      job.parentTaskId = previousJob.parentTaskId;
      job.wakeOnCompletion = previousJob.wakeOnCompletion;
      job.monitor = previousJob.monitor;
      job.responder = previousJob.responder;
      if (completion.created && completion.notification) {
        this.notifications.delete(completion.notification.id);
      } else if (completion.notification && previousNotification) {
        completion.notification.taskId = previousNotification.taskId;
        completion.notification.parentTaskId = previousNotification.parentTaskId;
        completion.notification.wakeOnCompletion = previousNotification.wakeOnCompletion;
        completion.notification.monitor = previousNotification.monitor;
        completion.notification.responder = previousNotification.responder;
      }
      return undefined;
    }
    this.emit({ type: "job", jobId: job.id });
    if (completion.notification) {
      this.emit({ type: "notification", jobId: job.id, notificationId: completion.notification.id });
    }
    return job;
  }

  async waitForJob(
    id: string,
    options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job) {
      const known = [...this.jobs.keys()].join(", ") || "none";
      return {
        ok: false,
        output: `Job "${id}" not found. Canonical job IDs: ${known}.`,
        exitCode: 1,
      };
    }
    const timeoutMs = Math.max(
      1_000,
      Math.min(options?.timeoutMs ?? WAIT_JOB_DEFAULT_TIMEOUT_MS, WAIT_JOB_MAX_TIMEOUT_MS),
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.refreshJobLiveness(job);
      if (!this.isLive(job)) break;
      if (options?.signal?.aborted) break;
      if (Date.now() >= deadline) {
        return {
          ok: true,
          output:
            `[${job.id}] still ${job.status} after waiting ${formatJobElapsed({ startedAt: new Date(Date.now() - timeoutMs).toISOString() })}. ` +
            `exit=? health=${processAlive(job.pid) ? "alive" : "unresponsive"} elapsed=${formatJobElapsed(job)}\n` +
            `$ ${job.commandDisplay}\n` +
            "The wait timed out, not the job. Do other useful work and wait again with a longer timeoutMs, " +
            "or stop it with shell.stop if it is no longer needed. Do not poll shell.jobs in a loop.",
          exitCode: 0,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_JOB_INTERVAL_MS));
    }
    const tail = await this.tailJob(job.id, { bytes: WAIT_JOB_TAIL_BYTES });
    return {
      ok: job.status === "exited" && (job.exitCode ?? 0) === 0,
      output:
        `[${job.id}] ${job.status} exit=${job.exitCode ?? "?"} elapsed=${formatJobElapsed(job)}\n` +
        `$ ${job.commandDisplay}\n${tail.output}`,
      exitCode: job.exitCode ?? 0,
    };
  }

  async tailJob(id: string, bytesOrCursor?: number | TailCursor): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job) {
      const known = [...this.jobs.keys()].join(", ") || "none";
      return { ok: false, output: `Job "${id}" not found. Canonical job IDs: ${known}.`, exitCode: 1 };
    }
    this.refreshJobLiveness(job);
    const pollingPolicy = responderPollingPolicy({
      call: { name: "shell.tail", args: { id } },
      targetJob: job,
    });
    if (pollingPolicy.blocked) {
      return {
        ok: true,
        output:
          pollingPolicy.reason ??
          `shell.tail was not dispatched because Responder owns job ${job.id}.`,
        exitCode: 0,
        suppressedRepeat: true,
      };
    }
    const cursor = typeof bytesOrCursor === "number" ? { bytes: bytesOrCursor } : (bytesOrCursor ?? {});
    const stream = cursor.stream ?? "stdout";
    if (stream === "combined" && cursor.offset !== undefined) {
      return {
        ok: false,
        output:
          "Incremental offsets are stream-specific. Poll stdout and stderr separately when using offset/nextOffset; combined is snapshot-only.",
        exitCode: 1,
      };
    }
    const paths = stream === "stderr" ? job.artifacts.stderr.chunks : stream === "stdout" ? job.artifacts.stdout.chunks : [...job.artifacts.stdout.chunks, ...job.artifacts.stderr.chunks];
    const readablePaths = paths.length > 0 ? paths : [stream === "stderr" ? job.stderrArtifact : job.stdoutArtifact];
    const path = readablePaths.at(-1)!;
    try {
      const sizes = await Promise.all(readablePaths.map(async (chunkPath) => ({ path: chunkPath, size: (await stat(chunkPath)).size })));
      const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
      const max = Math.max(1, Math.min(cursor.bytes ?? DEFAULT_TAIL_BYTES, 1024 * 1024));
      const start = cursor.offset === undefined ? Math.max(0, total - max) : Math.max(0, Math.min(cursor.offset, total));
      const length = Math.min(max, total - start);
      const parts: Buffer[] = [];
      let logical = 0;
      let remaining = length;
      for (const entry of sizes) {
        const chunkStart = logical;
        const chunkEnd = logical + entry.size;
        logical = chunkEnd;
        if (remaining <= 0 || start >= chunkEnd) continue;
        const localStart = Math.max(0, start - chunkStart);
        const localLength = Math.min(remaining, entry.size - localStart);
        const handle = await open(entry.path, "r");
        const buffer = Buffer.alloc(localLength);
        try { await handle.read(buffer, 0, localLength, localStart); } finally { await handle.close(); }
        parts.push(buffer);
        remaining -= localLength;
      }
      let combined = Buffer.concat(parts);
      // A fixed byte window can land mid-character (e.g. inside the 3-byte
      // "•" redaction marker). Trim any dangling lead byte(s) off the end so
      // decoding never mangles a character; the trimmed bytes are re-read
      // (and land on a boundary) on the caller's next offset-based poll.
      const trim = start + combined.length < total ? trailingIncompleteBytes(combined) : 0;
      if (trim > 0) combined = combined.subarray(0, combined.length - trim);
      const nextOffset = start + (length - remaining) - trim;
      return {
        ok: true,
        output:
          `[${job.id}] ${job.status} exit=${job.exitCode ?? "?"} signal=${job.signal ?? "?"} ` +
          `stream=${stream} offset=${start} nextOffset=${nextOffset} total=${total}:\n` +
          combined.toString("utf8"),
        outputPath: path,
        backgroundJob: {
          id: job.id,
          status: job.status,
          artifactPath: path,
          nextOffset,
          ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
          ...(job.signal !== undefined ? { signal: job.signal } : {}),
        },
      };
    } catch (error) {
      return { ok: false, output: `Failed to read job output: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
    }
  }

  async stopJob(
    id: string,
    options?: { signal?: NodeJS.Signals; graceMs?: number; escalate?: boolean; suppressWake?: boolean },
  ): Promise<ToolResult> {
    const resolved = this.resolveJobId(id);
    const job = resolved ? this.jobs.get(resolved) : undefined;
    if (!job || !resolved) return { ok: false, output: `Job "${id}" not found.`, exitCode: 1 };
    id = resolved;
    const inFlightFinalization = this.finalizations.get(id);
    if (inFlightFinalization) {
      const persisted = await inFlightFinalization;
      return persisted
        ? { ok: true, output: `Job "${id}" completed while stop was requested.` }
        : { ok: false, output: `Job "${id}" completed, but its terminal state could not be persisted.`, exitCode: 1 };
    }
    if (!this.isLive(job)) return { ok: false, output: `Job "${id}" is already ${job.status}.`, exitCode: 1 };
    const pid = job.pid;
    if (!pid) return { ok: false, output: `Job "${id}" has no process id to stop.`, exitCode: 1 };

    const processGroupId = process.platform !== "win32" ? job.processGroupId : undefined;
    const targetAlive = (): boolean => {
      if (!processGroupId) return processAlive(pid);
      try { process.kill(-processGroupId, 0); return true; } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const identityMatches = (): boolean => {
      if (process.platform === "win32") return processAlive(pid);
      const current = processIdentity(pid, { refresh: true });
      return Boolean(current && job.processIdentity && current === job.processIdentity);
    };
    if (targetAlive() && (!processAlive(pid) || !identityMatches())) {
      return {
        ok: false,
        output: `Refused to signal job "${id}": its persisted process identity no longer matches pid ${pid}.`,
        exitCode: 1,
      };
    }
    const child = this.processes.get(id);
    const childClose = child
      ? new Promise<void>((resolve) => child.once("close", () => resolve()))
      : undefined;

    this.clearAuthorizationTimer(id);
    const previousStatus = job.status;
    const previousWakeOnCompletion = job.wakeOnCompletion;
    if (options?.suppressWake) job.wakeOnCompletion = false;
    job.status = "stopping";
    if (!this.persistSync()) {
      job.status = previousStatus;
      job.wakeOnCompletion = previousWakeOnCompletion;
      this.scheduleAuthorizationExpiry(job);
      return { ok: false, output: `Failed to persist stop state for job "${id}"; no signal was sent.`, exitCode: 1 };
    }
    this.emit({ type: "job", jobId: id });
    this.abortControllers.get(id)?.abort();
    let processGroupVerified = false;
    const send = (
      signal: NodeJS.Signals,
      allowVerifiedGroup: boolean,
    ): "sent" | "gone" | "identity-mismatch" | "failed" => {
      if (!targetAlive()) return "gone";
      if (processAlive(pid) && identityMatches()) {
        processGroupVerified = true;
      } else if (!(processGroupId && processGroupVerified && allowVerifiedGroup)) {
        return "identity-mismatch";
      }
      const outcome = terminateProcessTree(pid, {
        signal,
        processGroupId,
      });
      if (outcome === "failed") return targetAlive() ? "failed" : "gone";
      return outcome;
    };
    const restoreRunning = (): void => {
      job.status = "running";
      this.scheduleAuthorizationExpiry(job);
      this.persistSync();
      this.emit({ type: "job", jobId: id });
    };
    const graceful = options?.signal ?? "SIGTERM";
    const firstSignal = send(graceful, false);
    if (firstSignal === "identity-mismatch" || firstSignal === "failed") {
      restoreRunning();
      return {
        ok: false,
        output: firstSignal === "identity-mismatch"
          ? `Refused to signal job "${id}": process identity changed immediately before stop.`
          : `Failed to signal job "${id}".`,
        exitCode: 1,
      };
    }
    const waitForExit = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!targetAlive()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return !targetAlive();
    };
    let stopped = firstSignal === "gone" || await waitForExit(options?.graceMs ?? 2_000);
    let actualSignal: NodeJS.Signals = graceful;
    if (!stopped && options?.escalate !== false) {
      actualSignal = "SIGKILL";
      const escalated = send(actualSignal, true);
      if (escalated === "identity-mismatch" || escalated === "failed") {
        restoreRunning();
        return {
          ok: false,
          output: escalated === "identity-mismatch"
            ? `Refused to escalate job "${id}": process identity changed before SIGKILL.`
            : `Failed to escalate job "${id}" with SIGKILL.`,
          exitCode: 1,
        };
      }
      stopped = escalated === "gone" || await waitForExit(1_000);
    }
    if (!stopped) {
      restoreRunning();
      return { ok: false, output: `Job "${id}" remains alive after ${actualSignal}.`, exitCode: 1 };
    }

    if (childClose) await childClose;
    let terminalPersisted = true;
    const eventFinalization = this.finalizations.get(id);
    if (eventFinalization) terminalPersisted = await eventFinalization;
    if (this.isLive(job)) {
      terminalPersisted = await this.finalizeJob(job, "killed", { signal: actualSignal });
    }
    if (!terminalPersisted) {
      return {
        ok: false,
        output: `Job "${id}" stopped, but its terminal state and completion notification could not be persisted.`,
        exitCode: 1,
      };
    }
    return { ok: true, output: `Job "${id}" stopped and termination verified (${actualSignal}).` };
  }

  async cancelAll(sessionId: string): Promise<ToolResult> {
    if (!sessionId) {
      return { ok: false, output: "cancelAll requires a non-empty session id.", exitCode: 1 };
    }
    const targets = [...this.jobs.values()].filter(
      (job) => this.isDurable(job) && job.ownerSessionId === sessionId && this.isLive(job),
    );
    const priorWake = new Map(targets.map((job) => [job.id, job.wakeOnCompletion]));
    for (const job of targets) {
      job.wakeOnCompletion = false;
      const notification = this.notificationForJob(job.id);
      if (notification) notification.wakeOnCompletion = false;
    }
    if (!this.persistSync()) {
      for (const job of targets) job.wakeOnCompletion = priorWake.get(job.id);
      return {
        ok: false,
        output: `Failed to persist wake suppression for session ${sessionId}; no jobs were cancelled.`,
        exitCode: 1,
      };
    }
    for (const job of targets) this.emit({ type: "job", jobId: job.id });

    const outcomes = await Promise.all(targets.map(async (job) => {
      const current = this.jobs.get(job.id);
      if (!current || !this.isLive(current)) return { id: job.id, ok: true, output: "already terminal" };
      try {
        const result = await this.stopJob(job.id, { suppressWake: true });
        return { id: job.id, ok: result.ok, output: result.output };
      } catch (error) {
        return { id: job.id, ok: false, output: error instanceof Error ? error.message : String(error) };
      }
    }));

    const acknowledgedAt = new Date().toISOString();
    const notificationSnapshots: Array<{
      notification: ResponderNotification;
      wakeOnCompletion: boolean;
      deliveredAt?: string | undefined;
      acknowledgedAt?: string | undefined;
    }> = [];
    for (const notification of this.notifications.values()) {
      if (notification.ownerSessionId !== sessionId || notification.acknowledgedAt) continue;
      notificationSnapshots.push({
        notification,
        wakeOnCompletion: notification.wakeOnCompletion,
        deliveredAt: notification.deliveredAt,
        acknowledgedAt: notification.acknowledgedAt,
      });
      notification.wakeOnCompletion = false;
      notification.discardedAt = acknowledgedAt;
      notification.discardReason = "session-cancelled";
      this.claimedNotifications.delete(notification.id);
    }
    const acknowledgementsPersisted = this.persistSync();
    if (!acknowledgementsPersisted) {
      for (const snapshot of notificationSnapshots) {
        snapshot.notification.wakeOnCompletion = snapshot.wakeOnCompletion;
        snapshot.notification.discardedAt = undefined;
        snapshot.notification.discardReason = undefined;
      }
    } else {
      for (const snapshot of notificationSnapshots) {
        this.emit({
          type: "notification",
          jobId: snapshot.notification.jobId,
          notificationId: snapshot.notification.id,
        });
      }
      this.pruneTerminalJobs();
      this.persistSync();
    }
    const failures = outcomes.filter((outcome) => !outcome.ok);
    if (failures.length > 0 || !acknowledgementsPersisted) {
      const details = failures.map((failure) => `[${failure.id}] ${failure.output}`);
      if (!acknowledgementsPersisted) details.push("Completion notifications could not be durably acknowledged.");
      return {
        ok: false,
        output:
          `Cancelled ${outcomes.length - failures.length}/${outcomes.length} background job(s) for session ${sessionId}; ` +
          `${details.length} failure(s):\n${details.join("\n")}`,
        exitCode: 1,
      };
    }
    return {
      ok: true,
      output: targets.length === 0
        ? `No running background jobs for session ${sessionId}; pending notifications were acknowledged.`
        : `Cancelled ${targets.length} background job(s) for session ${sessionId}; wake notifications were suppressed and acknowledged.`,
    };
  }

  getRunningJobs(sessionId?: string): BackgroundJob[] {
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    return [...this.jobs.values()].filter(
      (job) =>
        this.isDurable(job) &&
        this.isLive(job) &&
        this.matchesSession(job, sessionId),
    );
  }

  getRecentJobs(limit = 50, sessionId?: string): BackgroundJob[] {
    for (const job of this.jobs.values()) this.refreshJobLiveness(job);
    return [...this.jobs.values()]
      .filter(
        (job) => this.isDurable(job) && this.matchesSession(job, sessionId),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  /** Drop stale terminal durable jobs and all leftover ephemeral rows. */
  pruneTerminalJobs(): void {
    const now = Date.now();
    const archivedUnsettled = [...this.notifications.values()]
      .filter(
        (notification) =>
          Boolean(notification.archivedAt) &&
          !notification.acknowledgedAt &&
          !notification.settledAt,
      )
      .sort((left, right) =>
        (right.archivedAt ?? right.createdAt).localeCompare(
          left.archivedAt ?? left.createdAt,
        ),
      );
    for (const [index, notification] of archivedUnsettled.entries()) {
      const archivedAt = Date.parse(
        notification.archivedAt ?? notification.endedAt ?? notification.createdAt,
      );
      const expired =
        Number.isFinite(archivedAt) &&
        now - archivedAt > ARCHIVED_UNSETTLED_MAX_AGE_MS;
      if (index < MAX_ARCHIVED_UNSETTLED_NOTIFICATIONS && !expired) continue;
      this.notifications.delete(notification.id);
      const timer = this.settlementTimers.get(notification.jobId);
      if (timer) clearTimeout(timer);
      this.settlementTimers.delete(notification.jobId);
      this.pendingSettlements.delete(notification.jobId);
    }
    for (const [id, notification] of this.notifications) {
      const job = this.jobs.get(notification.jobId);
      if (
        !job ||
        notification.discardedAt ||
        (notification.acknowledgedAt && job.status !== "lost")
      ) {
        this.notifications.delete(id);
      }
    }
    for (const [jobId] of this.consumedResponderResults) {
      if (!this.jobs.has(jobId)) this.consumedResponderResults.delete(jobId);
    }
    const durableTerminal: BackgroundJob[] = [];
    for (const [id, job] of this.jobs) {
      if (!this.isDurable(job)) {
        // Safety: never keep ephemeral rows that are not live.
        if (!this.isLive(job)) this.forgetJob(id);
        continue;
      }
      if (this.isLive(job)) continue;
      const notification = this.notificationForJob(job.id);
      if (
        notification &&
        !notification.acknowledgedAt &&
        !(notification.archivedAt && notification.settledAt)
      ) {
        continue;
      }
      const ended = job.endedAt ? Date.parse(job.endedAt) : Date.parse(job.startedAt);
      if (Number.isFinite(ended) && now - ended > TERMINAL_JOB_MAX_AGE_MS) {
        this.forgetJob(id);
        continue;
      }
      durableTerminal.push(job);
    }
    if (durableTerminal.length <= MAX_DURABLE_TERMINAL_JOBS) return;
    durableTerminal.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const job of durableTerminal.slice(MAX_DURABLE_TERMINAL_JOBS)) {
      this.forgetJob(job.id);
    }
  }

  private loadAndReconcile(): void {
    try {
      let parsed: PersistedRegistry | undefined;
      const sourcePath = existsSync(this.registryPath)
        ? this.registryPath
        : this.transientV2RegistryPath;
      if (!existsSync(sourcePath)) return;
      try {
        const candidate = JSON.parse(readFileSync(sourcePath, "utf8")) as PersistedRegistry;
        if ((candidate.schemaVersion === 1 || candidate.schemaVersion === 2) && Array.isArray(candidate.jobs)) {
          parsed = candidate;
        }
      } catch { /* a corrupt current registry must not replay stale v1 state */ }
      if (!parsed) return;
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.settlements)) {
        for (const settlement of parsed.settlements) {
          if (!settlement || typeof settlement.jobId !== "string") continue;
          this.pendingSettlements.set(settlement.jobId, settlement);
        }
      }
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.consumedResults)) {
        for (const consumed of parsed.consumedResults) {
          if (
            !consumed ||
            typeof consumed.jobId !== "string" ||
            typeof consumed.resultHash !== "string"
          ) {
            continue;
          }
          this.consumedResponderResults.set(consumed.jobId, consumed);
        }
      }
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.notifications)) {
        const notifiedJobs = new Set<string>();
        for (const notification of parsed.notifications) {
          if (!notification || typeof notification.id !== "string" || typeof notification.jobId !== "string") continue;
          if (notifiedJobs.has(notification.jobId)) continue;
          notifiedJobs.add(notification.jobId);
          if (!notification.acknowledgedAt && !notification.archivedAt) {
            // A durable receipt must survive the restart it exists for. Drop the
            // dead runtime lease so the next activated lease can adopt it.
            delete notification.responderLeaseId;
          }
          this.notifications.set(notification.id, notification);
        }
      }
      for (const job of parsed.jobs) {
        if (job.kind === "ephemeral" || looksLikeEphemeralToolTrack(job)) continue;
        job.kind = "durable";
        if (["starting", "running", "stopping"].includes(job.status)) {
          const alive = processAlive(job.pid);
          const identity = alive ? processIdentity(job.pid) : undefined;
          // Only declare lost when the process is truly gone, or when we can
          // PROVE a pid reuse (stored + current identity both known and
          // different). An alive pid whose identity is unknown/unreadable is
          // kept running — never kill a live process over a failed `ps` read.
          const provenReuse = Boolean(
            identity && job.processIdentity && identity !== job.processIdentity,
          );
          if (!alive || provenReuse) {
            job.status = "lost";
            job.endedAt = new Date().toISOString();
          } else {
            job.status = "running";
            job.heartbeatAt = new Date().toISOString();
          }
        }
        delete job.timeoutAt;
        this.jobs.set(job.id, job);
        this.ensureCompletionNotification(job);
        this.scheduleAuthorizationExpiry(job);
        this.scheduleTaskSettlement(job);
      }
      for (const [id, notification] of this.notifications) {
        const job = this.jobs.get(notification.jobId);
        if (!job?.responder) this.notifications.delete(id);
      }
      this.scheduleLivenessWatch();
      this.pruneTerminalJobs();
      this.persistSync();
    } catch { /* Corrupt registries are ignored, never trusted as running. */ }
  }

  /** Only durable jobs and responder notifications are written to disk. */
  private registry(): PersistedRegistryV2 {
    return {
      schemaVersion: 2,
      jobs: [...this.jobs.values()].filter((job) => this.isDurable(job)),
      notifications: [...this.notifications.values()],
      ...(this.pendingSettlements.size
        ? { settlements: [...this.pendingSettlements.values()] }
        : {}),
      ...(this.consumedResponderResults.size
        ? { consumedResults: [...this.consumedResponderResults.values()] }
        : {}),
    };
  }
  private scheduleRegistryRetry(): void {
    if (this.registryRetryTimer) return;
    const timer = setTimeout(() => {
      this.registryRetryTimer = undefined;
      if (!this.persistSync()) this.scheduleRegistryRetry();
    }, 250);
    timer.unref?.();
    this.registryRetryTimer = timer;
  }

  private persistSync(): boolean {
    try {
      mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
      const temp = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.registry(), null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.registryPath);
      return true;
    } catch {
      return false;
    }
  }
  private async persist(): Promise<void> {
    if (!this.persistSync()) throw new Error("Failed to persist the background-job registry.");
  }
}

export const jobManager = new JobManager();
