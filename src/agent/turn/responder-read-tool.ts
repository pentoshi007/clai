import type { ResponderNotification } from "../../tools/jobs.js";

export interface ResponderReadRequest {
  readonly toolName: string;
  readonly notificationId: string;
  readonly jobId: string;
}

export interface ResponderReadWakeIdentity {
  readonly wakeTurn: boolean;
  readonly notificationId: string | undefined;
  readonly jobId: string | undefined;
  readonly resultRevision: number | undefined;
}

export interface ResponderReadPorts {
  readonly pendingNotifications: readonly ResponderNotification[];
  readonly matchesWakeRevision: (notification: ResponderNotification) => boolean;
  readonly isClaimed: (notificationId: string) => boolean;
  readonly markRead: (notificationId: string) => boolean;
}

export interface ResponderReadDecision {
  readonly marked: boolean;
  readonly output: string;
  readonly ledgerNotification: ResponderNotification | undefined;
  readonly releaseClaimId: string | undefined;
}

export const parseResponderReadRequest = (
  toolName: string,
  args: Record<string, unknown>,
): ResponderReadRequest => ({
  toolName,
  notificationId:
    typeof args.notificationId === "string" ? args.notificationId.trim() : "",
  jobId: typeof args.jobId === "string" ? args.jobId.trim() : "",
});

const failureText = (
  request: ResponderReadRequest,
  identifiersConflict: boolean,
  notification: ResponderNotification | undefined,
  visible: boolean,
  identifier: string,
): string => {
  if (!request.notificationId && !request.jobId) {
    return `${request.toolName} failed: jobId or notificationId is required.`;
  }
  if (identifiersConflict) {
    return `${request.toolName} failed: jobId and notificationId refer to different Responder results.`;
  }
  if (!notification) {
    return `${request.toolName} failed: Responder result ${identifier} is unavailable, consumed, or archived.`;
  }
  if (!visible) {
    return `${request.toolName} failed: Responder result ${identifier} was not delivered to this model turn. Analyze a delivered result before marking it read.`;
  }
  return `${request.toolName} failed: read state for Responder result ${identifier} could not be persisted.`;
};

export const decideResponderRead = (
  request: ResponderReadRequest,
  wake: ResponderReadWakeIdentity,
  ports: ResponderReadPorts,
): ResponderReadDecision => {
  const eligible = wake.wakeTurn
    ? ports.pendingNotifications.filter(ports.matchesWakeRevision)
    : ports.pendingNotifications;
  const byNotification = request.notificationId
    ? eligible.find((candidate) => candidate.id === request.notificationId)
    : undefined;
  const byJob = request.jobId
    ? eligible.find((candidate) => candidate.jobId === request.jobId)
    : undefined;
  const identifiersConflict = Boolean(
    (byNotification &&
      request.jobId &&
      byNotification.jobId !== request.jobId) ||
      (byJob && request.notificationId && byJob.id !== request.notificationId),
  );
  const notification = identifiersConflict
    ? undefined
    : (byNotification ?? byJob);
  const visible = Boolean(notification && ports.isClaimed(notification.id));
  const wakeIdentityMatches = Boolean(
    wake.wakeTurn &&
      (request.notificationId || request.jobId) &&
      (!request.notificationId ||
        request.notificationId === wake.notificationId) &&
      (!request.jobId || request.jobId === wake.jobId),
  );
  const staleWakeSettled =
    wakeIdentityMatches && !identifiersConflict && !notification;
  const persistedRead = Boolean(
    notification && visible && ports.markRead(notification.id),
  );
  const marked = persistedRead || staleWakeSettled;
  const identifier = request.jobId || request.notificationId;
  const revisionLabel = wake.resultRevision
    ? ` revision ${wake.resultRevision}`
    : "";

  if (persistedRead && notification) {
    return {
      marked,
      output: `Responder job ${notification.jobId} (${notification.id}) marked delivered and read after model analysis.`,
      ledgerNotification: notification,
      releaseClaimId: notification.id,
    };
  }
  if (staleWakeSettled) {
    return {
      marked,
      output: `Responder result ${identifier}${revisionLabel} was already settled or discarded; the stale wake is acknowledged idempotently.`,
      ledgerNotification: undefined,
      releaseClaimId: wake.notificationId,
    };
  }
  return {
    marked,
    output: failureText(
      request,
      identifiersConflict,
      notification,
      visible,
      identifier,
    ),
    ledgerNotification: undefined,
    releaseClaimId: undefined,
  };
};
