import type {
  JobManagerChange,
  JobsPort,
  ResponderNotification,
} from "../ports/jobs-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";

interface ResponderTurnResult {
  readonly status: "completed" | "aborted" | "error";
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
    this.deps.notifyState();
    if (change.type === "notification") this.scheduleWake();
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
        if (
          this.wakeRequested &&
          generation === this.generation &&
          !this.deps.isBusy()
        ) {
          queueMicrotask(() => this.scheduleWake());
        }
      });
    this.wakeDrain = drain;
  }

  private async drainOne(generation: number): Promise<void> {
    if (generation !== this.generation || !this.leaseId) return;
    if (this.deps.isBusy()) return;
    if (this.deps.hasQueuedWork()) {
      this.wakeRequested = false;
      await this.deps.continueQueue();
      return;
    }

    this.wakeRequested = false;
    const sessionId = this.deps.sessionId();
    const leaseId = this.leaseId;
    const notification = this.deps.jobs.claimNextResponderNotification(
      sessionId,
      leaseId,
    );
    if (!notification) {
      this.deps.notifyState();
      return;
    }

    this.deps.notifyState();
    const preview = await this.preview(notification);
    const foreground = await this.foregroundTask(sessionId);
    if (
      generation !== this.generation ||
      leaseId !== this.leaseId ||
      sessionId !== this.deps.sessionId() ||
      this.deps.isBusy()
    ) {
      this.deps.jobs.releaseResponderNotificationClaim?.(notification.id);
      this.deps.notifyState();
      return;
    }
    let result: ResponderTurnResult;
    try {
      result = await this.deps.runTurn(
        deliveryPrompt(notification, preview, foreground),
        () => {
          if (!this.deps.jobs.markDeliveryStarted(notification.id, sessionId)) {
            throw new Error(
              `failed to persist responder delivery attempt ${notification.id}`,
            );
          }
          this.deps.notifyState();
          this.deps.notifyDelivery?.(summarizeDelivery(notification));
        },
      );
    } catch {
      result = { status: "error" };
    }

    if (
      result.status !== "completed" ||
      generation !== this.generation ||
      leaseId !== this.leaseId ||
      sessionId !== this.deps.sessionId()
    ) {
      if (!notification.deliveryStartedAt) {
        this.deps.jobs.releaseResponderNotificationClaim?.(notification.id);
      }
      this.wakeRequested = false;
      this.deps.notifyState();
      return;
    }
    if (!this.deps.jobs.markDelivered(notification.id, sessionId)) {
      this.deps.jobs.releaseResponderNotificationClaim?.(notification.id);
      this.deps.notifyState();
      return;
    }

    if (!notification.readAt) {
      this.deps.notifyState();
      return;
    }
    this.deps.notifyState();
    if (this.hasDeliverable(sessionId, leaseId)) {
      this.wakeRequested = true;
    }
  }

  private hasDeliverable(sessionId: string, leaseId: string): boolean {
    return this.deps.jobs.pendingNotifications(sessionId).some(
      (notification) =>
        notification.responder &&
        notification.responderLeaseId === leaseId &&
        !notification.archivedAt &&
        !notification.deliveredAt &&
        !notification.readAt &&
        !notification.analyzedAt,
    );
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

function summarizeDelivery(notification: ResponderNotification): string {
  const label = (notification.commandDisplay || notification.jobId)
    .replace(/\s+/g, " ")
    .trim();
  const short = label.length > 64 ? `${label.slice(0, 63)}…` : label;
  const outcome =
    notification.status === "exited"
      ? "result"
      : `${notification.status} result`;
  return `Responder → model · ${short} ${outcome}`;
}
