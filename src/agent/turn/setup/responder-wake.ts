import type { ResponderNotification } from "../../../tools/jobs.js";
import {
  findResponderWakeNotification,
  parseResponderWake,
  responderWakeMatchesRevision,
} from "../responder-inbox.js";

export interface ResponderWakeSetup {
  readonly wakeTurn: boolean;
  readonly notificationId: string | undefined;
  readonly jobId: string | undefined;
  readonly resultRevision: number | undefined;
  readonly wake: ReturnType<typeof parseResponderWake>;
  readonly matchesRevision: (notification: ResponderNotification) => boolean;
  readonly claimedNotificationId: string | undefined;
}

export const setUpResponderWake = (input: {
  readonly prompt: string;
  readonly displayPrompt: string | null | undefined;
  readonly pendingNotifications: readonly ResponderNotification[];
}): ResponderWakeSetup => {
  const wake = parseResponderWake({
    prompt: input.prompt,
    displayPrompt: input.displayPrompt,
  });
  const claimed = findResponderWakeNotification(
    wake,
    input.pendingNotifications,
  );
  return {
    wakeTurn: wake.wakeTurn,
    notificationId: wake.notificationId,
    jobId: wake.jobId,
    resultRevision: wake.resultRevision,
    wake,
    matchesRevision: (notification) =>
      responderWakeMatchesRevision(wake, notification),
    claimedNotificationId: claimed?.id,
  };
};
