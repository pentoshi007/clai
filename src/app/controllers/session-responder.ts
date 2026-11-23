import type {
  JobManagerChange,
  JobsPort,
  ResponderNotification,
} from "../ports/jobs-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { TurnOutcome } from "../../agent/turn-outcome.js";
import { jobTitle } from "../../tools/jobs/title.js";

interface ResponderTurnResult {
  readonly status: "completed" | "aborted" | "error";
  readonly outcome?: Pick<TurnOutcome, "status"> | undefined;
}

export type ResponderListeningMode = "off" | "idle" | "listening";

export interface ResponderRuntimeState {
  readonly mode: ResponderListeningMode;
  readonly running: number;
  readonly ready: number;
  readonly delivered: number;
  readonly archived: number;
  readonly failed: number;
}

export const IDLE_RESPONDER_STATE: ResponderRuntimeState = Object.freeze({
  mode: "off",
  running: 0,
  ready: 0,
  delivered: 0,
  archived: 0,
  failed: 0,
});

interface SessionResponderDeps {
  readonly jobs: JobsPort;
  readonly persistence: PersistencePort;
  readonly sessionId: () => string;
  readonly isBusy: () => boolean;
  readonly hasQueuedWork: () => boolean;
  readonly continueQueue: () => Promise<void>;
  readonly runTurn: (
    prompt: string,
    onStarted: () => void,
  ) => Promise<ResponderTurnResult>;
  readonly notifyState: () => void;
  readonly notifyDelivery?: ((summary: string) => void) | undefined;
}

const PREVIEW_BYTES = 4 * 1024;
const PREVIEW_LINES = 20;

export class SessionResponder {
  private leaseId: string | undefined;
  private deactivatedAt = Date.now();
  private generation = 0;
  private wakeRequested = false;
  private wakeDrain: Promise<void> | undefined;

  constructor(private readonly deps: SessionResponderDeps) {}

  activate(): void {
    if (this.leaseId) return;
    this.leaseId = this.deps.jobs.activateResponderLease(this.deps.sessionId());
    this.deps.notifyState();
    this.scheduleWake();
  }

  deactivate(): void {
    const leaseId = this.leaseId;
    this.leaseId = undefined;
    this.deactivatedAt = Date.now();
    this.generation += 1;
    this.wakeRequested = false;
    if (leaseId) {
      this.deps.jobs.releaseResponderLease(this.deps.sessionId(), leaseId);
    }
    this.deps.notifyState();
  }

  invalidateWake(): void {
    this.deactivate();
  }

  rebind(): void {
    this.deactivate();
  }

  handleChange(change: JobManagerChange): void {
    if (change.type === "job" && this.isNewOwnedResponderJob(change.jobId)) {
      this.activate();
      return;
    }
    this.deps.notifyState();
    if (change.type === "notification") this.scheduleWake();
  }

  private isNewOwnedResponderJob(jobId: string): boolean {
    if (this.leaseId) return false;
    const job = this.deps.jobs.get(jobId);
    if (!job?.responder) return false;
    if (job.ownerSessionId !== this.deps.sessionId()) return false;
    if (job.status !== "starting" && job.status !== "running") return false;
    return Date.parse(job.startedAt) > this.deactivatedAt;
  }

  getState(): ResponderRuntimeState {
    const sessionId = this.deps.sessionId();
    const notifications = this.deps.jobs
      .pendingNotifications(sessionId)
      .filter((notification) => notification.responder);
    const live = this.deps.jobs
      .running(sessionId)
      .filter((job) => job.responder);
    const active = this.leaseId;
    const current = notifications.filter(
      (notification) =>
        Boolean(active) &&
        notification.responderLeaseId === active &&
        !notification.archivedAt,
    );
    const ready = current.filter(
      (notification) =>
        !notification.deliveredAt &&
        !notification.readAt &&
        !notification.analyzedAt,
    ).length;
    const delivered = current.filter(
      (notification) =>
        notification.deliveredAt &&
        !notification.readAt &&
        !notification.analyzedAt,
    ).length;
    const archived = notifications.filter((notification) =>
      Boolean(notification.archivedAt),
    ).length;
    const running = live.length;
    const failed = notifications.filter(
      (notification) => notification.status !== "exited",
    ).length;
    return {
      mode: !active
        ? "off"
        : running > 0 || ready > 0 || delivered > 0
          ? "listening"
          : "idle",
      running,
      ready,
      delivered,
      archived,
      failed,
    };
  }

  scheduleWake(): void {
    if (!this.leaseId) return;
    this.wakeRequested = true;
    if (this.deps.isBusy() || this.wakeDrain) return;
    const generation = this.generation;
    let drain: Promise<void>;
    drain = Promise.resolve()
      .then(() => this.drainOne(generation))
      .finally(() => {
        if (this.wakeDrain !== drain) return;
        this.wakeDrain = undefined;
        if (this.wakeRequested && !this.deps.isBusy()) {
          queueMicrotask(() => this.scheduleWake());
        }
      });
    this.wakeDrain = drain;
  }

  private async drainOne(generation: number): Promise<void> {
    const leaseId = this.leaseId;
    if (!leaseId || generation !== this.generation || this.deps.isBusy()) return;
    this.wakeRequested = false;
    if (this.deps.hasQueuedWork()) {
      await this.deps.continueQueue();
      return;
    }

    const sessionId = this.deps.sessionId();
    const notification = this.deps.jobs.claimNextResponderNotification(sessionId, leaseId, "wake");
    if (!notification) {
      this.deps.notifyState();
      return;
    }
    const isCurrent = () => generation === this.generation && sessionId === this.deps.sessionId();
    try {
      this.deps.notifyState();
      await this.deliverClaimedResult(notification, isCurrent);
    } catch {
      if (isCurrent()) this.wakeRequested = false;
    } finally {
      if (isCurrent()) {
        this.deps.jobs.releaseResponderNotificationClaim?.(notification.id);
        this.deps.notifyState();
      }
    }
  }

  private async deliverClaimedResult(
    notification: ResponderNotification,
    isCurrent: () => boolean,
  ): Promise<void> {
    const sessionId = notification.ownerSessionId;
    const [preview, foreground] = await Promise.all([
      this.preview(notification),
      this.foregroundTask(sessionId),
    ]);
    if (!isCurrent() || this.deps.isBusy()) return;

    const result = await this.deps.runTurn(deliveryPrompt(notification, preview, foreground), () => {
      if (!this.deps.jobs.markDeliveryStarted(notification.id, sessionId)) {
        throw new Error(`failed to persist responder delivery attempt ${notification.id}`);
      }
      this.deps.notifyState();
      this.deps.notifyDelivery?.(summarizeDelivery(notification, this.deps.jobs));
    });
    if (!isCurrent()) return;

    if (result.status !== "completed" || result.outcome?.status === "aborted") {
      this.wakeRequested = false;
      return;
    }
    if (!notification.readAt && this.deps.jobs.markDelivered(notification.id, sessionId)) {
      this.settleUnread(notification.id, sessionId);
    }
    this.wakeRequested = true;
  }

  private settleUnread(notificationId: string, sessionId: string): void {
    if (this.deps.jobs.markAnalyzed(notificationId, sessionId)) {
      this.deps.jobs.acknowledge(notificationId, sessionId);
    }
  }

  private async preview(notification: ResponderNotification): Promise<string> {
    try {
      const tailed = await this.deps.jobs.tail(notification.jobId, PREVIEW_BYTES);
      return boundedPreview(tailed.output);
    } catch {
      return "[preview unavailable; use the durable artifact path if analysis needs more]";
    }
  }

  private async foregroundTask(sessionId: string): Promise<string | undefined> {
    try {
      const plan = await this.deps.persistence.loadPlan(sessionId);
      const task = plan?.tasks.find(
        (candidate) =>
          !candidate.responderOwned && candidate.state === "in_progress",
      );
      return task ? `[${task.id}] ${task.title}` : undefined;
    } catch {
      return undefined;
    }
  }
}

function boundedPreview(value: string): string {
  let text = value.replace(/\uFFFD/g, "").replace(/\r/g, "").split("\n").slice(0, PREVIEW_LINES).join("\n");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= PREVIEW_BYTES) return text;
  text = bytes
    .subarray(0, PREVIEW_BYTES)
    .toString("utf8")
    .replace(/\uFFFD/g, "");
  return `${text}\n[preview truncated]`;
}

function deliveryPrompt(
  notification: ResponderNotification,
  preview: string,
  foreground: string | undefined,
): string {
  const artifact =
    notification.stdoutArtifact.chunks.at(-1) ??
    notification.stdoutArtifact.path;
  const resume = foreground
    ? `After handling this result, resume exactly the interrupted foreground task ${foreground}. Do not repeat its completed work.`
    : "No active plan is required. After acknowledging the job, report its result directly; do not create or update a plan solely to consume this receipt.";
  return [
    "Responder result arrived while the model was idle.",
    `notification=${notification.id}`,
    `job=${notification.jobId}`,
    `resultRevision=${notification.resultRevision ?? 1}`,
    `status=${notification.status}`,
    `durationMs=${Math.max(0, Date.parse(notification.endedAt) - Date.parse(notification.startedAt))}`,
    `stdoutBytes=${notification.stdoutArtifact.bytes}`,
    `stderrBytes=${notification.stderrArtifact.bytes}`,
    `artifact=${artifact}`,
    "Preview (maximum 20 lines / 4 KiB):",
    preview,
    "Review this compact result. Gather only bounded evidence still needed to understand it. Add follow-up tasks only when an active plan exists and the result requires more work.",
    `MANDATORY ACKNOWLEDGMENT: after analyzing this result and deciding the job is finished, call job.read with jobId=${notification.jobId} or notificationId=${notification.id}. job.read requires no plan, atomically records delivery + read, and must happen before a final response.`,
    "Do not rerun the completed responder command, poll it, or update its responder-owned task; settlement follows the authoritative process result independently.",
    resume,
  ].join("\n");
}

function summarizeDelivery(notification: ResponderNotification, jobs: JobsPort): string {
  const title = jobTitle(jobs.get(notification.jobId));
  const outcome = notification.status === "exited" ? "result" : `${notification.status} result`;
  return `Responder → model · ${title} ${outcome}`;
}
