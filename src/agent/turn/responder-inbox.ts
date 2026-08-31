import type { ChatMessage } from "../../types.js";
import type { BackgroundJob, ResponderNotification } from "../../tools/jobs.js";
import {
  responderContextMessage,
  upsertResponderContextMessage,
} from "../responder-context.js";

export interface ResponderWake {
  readonly wakeTurn: boolean;
  readonly notificationId: string | undefined;
  readonly jobId: string | undefined;
  readonly resultRevision: number | undefined;
}

export interface ResponderClaimView {
  add(notificationId: string): void;
  has(notificationId: string): boolean;
}

export interface ResponderInboxPorts {
  readonly messages: ChatMessage[];
  readonly wake: ResponderWake;
  readonly claims: ResponderClaimView;
  readonly getRunningJobs: () => readonly BackgroundJob[];
  readonly getPendingNotifications: () => readonly ResponderNotification[];
  readonly getResponderLeaseId: () => string | undefined;
  readonly claimNextNotification: (
    leaseId: string,
  ) => ResponderNotification | undefined;
}

const WAKE_PENDING_LIMIT = 1;
const INBOX_PENDING_LIMIT = 12;

export const parseResponderWake = (input: {
  readonly prompt: string;
  readonly displayPrompt: string | null | undefined;
}): ResponderWake => {
  const wakeTurn =
    input.displayPrompt === null &&
    input.prompt.startsWith("Responder result arrived");
  if (!wakeTurn) {
    return {
      wakeTurn: false,
      notificationId: undefined,
      jobId: undefined,
      resultRevision: undefined,
    };
  }
  return {
    wakeTurn: true,
    notificationId: /^notification=(.+)$/m.exec(input.prompt)?.[1]?.trim(),
    jobId: /^job=(.+)$/m.exec(input.prompt)?.[1]?.trim(),
    resultRevision:
      Number(/^resultRevision=(\d+)$/m.exec(input.prompt)?.[1]) || undefined,
  };
};

export const responderWakeMatchesRevision = (
  wake: ResponderWake,
  notification: ResponderNotification,
): boolean =>
  wake.resultRevision === undefined ||
  (notification.resultRevision ?? 1) === wake.resultRevision;

export const findResponderWakeNotification = (
  wake: ResponderWake,
  pending: readonly ResponderNotification[],
): ResponderNotification | undefined =>
  wake.notificationId
    ? pending.find(
        (notification) =>
          notification.id === wake.notificationId &&
          (!wake.jobId || notification.jobId === wake.jobId) &&
          responderWakeMatchesRevision(wake, notification),
      )
    : undefined;

const isDeliverable = (notification: ResponderNotification): boolean =>
  notification.responder &&
  !notification.readAt &&
  !notification.analyzedAt &&
  !notification.archivedAt;

const refresh = (
  ports: ResponderInboxPorts,
): ResponderNotification | undefined => {
  const running = ports.getRunningJobs().filter((job) => job.responder);
  if (ports.wake.wakeTurn) {
    const pending = ports
      .getPendingNotifications()
      .filter(
        (notification) =>
          isDeliverable(notification) &&
          ports.claims.has(notification.id) &&
          responderWakeMatchesRevision(ports.wake, notification),
      )
      .slice(0, WAKE_PENDING_LIMIT);
    upsertResponderContextMessage(
      ports.messages,
      responderContextMessage({ running, pending }),
    );
    return undefined;
  }
  const leaseId = ports.getResponderLeaseId();
  const delivery = leaseId ? ports.claimNextNotification(leaseId) : undefined;
  if (delivery) ports.claims.add(delivery.id);
  const pending = ports
    .getPendingNotifications()
    .filter(
      (notification) =>
        isDeliverable(notification) && ports.claims.has(notification.id),
    )
    .slice(0, INBOX_PENDING_LIMIT);
  upsertResponderContextMessage(
    ports.messages,
    responderContextMessage({ running, pending }),
  );
  return delivery;
};

export const createResponderInboxRefresher =
  (ports: ResponderInboxPorts) => (): ResponderNotification | undefined =>
    refresh(ports);
