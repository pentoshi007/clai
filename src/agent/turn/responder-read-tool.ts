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

interface ResponderReadMatch {
  readonly notification: ResponderNotification | undefined;
  readonly identifiersConflict: boolean;
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

const findMatch = (
  request: ResponderReadRequest,
  wake: ResponderReadWakeIdentity,
  ports: ResponderReadPorts,
): ResponderReadMatch => {
  const eligible = wake.wakeTurn
    ? ports.pendingNotifications.filter(ports.matchesWakeRevision)
    : ports.pendingNotifications;
  const byNotification = request.notificationId
    ? eligible.find((candidate) => candidate.id === request.notificationId)
    : undefined;
  const byJob = request.jobId
    ? eligible.find((candidate) => candidate.jobId === request.jobId)
    : undefined;
  const notificationMismatch = Boolean(
    byNotification && request.jobId && byNotification.jobId !== request.jobId,
  );
  const jobMismatch = Boolean(
    byJob && request.notificationId && byJob.id !== request.notificationId,
  );
  const identifiersConflict = notificationMismatch || jobMismatch;
  return {
    notification: identifiersConflict ? undefined : (byNotification ?? byJob),
    identifiersConflict,
  };
};

const wakeIdentityMatches = (
  request: ResponderReadRequest,
  wake: ResponderReadWakeIdentity,
): boolean => {
  if (!wake.wakeTurn) return false;
  if (!request.notificationId && !request.jobId) return false;
  const notificationMatches =
    !request.notificationId || request.notificationId === wake.notificationId;
  const jobMatches = !request.jobId || request.jobId === wake.jobId;
  return notificationMatches && jobMatches;
};

const failureText = (
  request: ResponderReadRequest,
  match: ResponderReadMatch,
  visible: boolean,
  identifier: string,
): string => {
  if (!request.notificationId && !request.jobId) {
    return `${request.toolName} failed: jobId or notificationId is required.`;
  }
  if (match.identifiersConflict) {
    return `${request.toolName} failed: jobId and notificationId refer to different Responder results.`;
  }
  if (!match.notification) {
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
  const match = findMatch(request, wake, ports);
  const notification = match.notification;
  const visible = Boolean(notification && ports.isClaimed(notification.id));
  const persistedRead = Boolean(
    notification && visible && ports.markRead(notification.id),
  );

  if (persistedRead && notification) {
    return {
      marked: true,
      output: `Responder job ${notification.jobId} (${notification.id}) marked delivered and read after model analysis.`,
      ledgerNotification: notification,
      releaseClaimId: notification.id,
    };
  }

  const staleWakeSettled =
    !notification &&
    !match.identifiersConflict &&
    wakeIdentityMatches(request, wake);
  const identifier = request.jobId || request.notificationId;

  if (staleWakeSettled) {
    const revisionLabel = wake.resultRevision
      ? ` revision ${wake.resultRevision}`
      : "";
    return {
      marked: true,
      output: `Responder result ${identifier}${revisionLabel} was already settled or discarded; the stale wake is acknowledged idempotently.`,
      ledgerNotification: undefined,
      releaseClaimId: wake.notificationId,
    };
  }

  return {
    marked: false,
    output: failureText(request, match, visible, identifier),
    ledgerNotification: undefined,
    releaseClaimId: undefined,
  };
};
