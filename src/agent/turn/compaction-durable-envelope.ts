import type { ChatMessage } from "../../types.js";
import type { OutcomeEnvelope } from "../outcomes.js";
import type { SessionPlan } from "../../store/plan.js";
import {
  buildDurableEnvelope,
  type EnvelopeJobState,
  type WorkLedger,
} from "../durable-envelope.js";
import { isResponderResultLedgerMessage } from "../responder-context.js";

export interface CompactionEnvelopeJob {
  readonly id: string;
  readonly status: string;
  readonly command: string;
  readonly commandDisplay: string;
  readonly taskId?: string | undefined;
  readonly stdoutArtifact?: string | undefined;
}

export interface CompactionDurableEnvelopePorts {
  readonly messages: readonly ChatMessage[];
  readonly outcome: OutcomeEnvelope;
  readonly ledger: WorkLedger;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly getProjectRoot: () => string | undefined;
  readonly detectPackageManager: (root: string) => string | undefined;
  readonly getUnreadNotificationIds: () => readonly string[];
  readonly getRunningJobs: () => readonly CompactionEnvelopeJob[];
  readonly getRecentJobs: () => readonly CompactionEnvelopeJob[];
}

const consumedNotificationIds = (
  messages: readonly ChatMessage[],
): string[] => {
  const consumed: string[] = [];
  for (const message of messages) {
    if (!isResponderResultLedgerMessage(message)) continue;
    for (const line of message.content.split("\n")) {
      const match = /notification=(\S+)/.exec(line);
      if (match?.[1]) consumed.push(match[1]);
    }
  }
  return [...new Set(consumed)];
};

const envelopeJob = (job: CompactionEnvelopeJob): EnvelopeJobState => ({
  id: job.id,
  status: job.status,
  command: job.commandDisplay || job.command,
  ...(job.taskId ? { taskId: job.taskId } : {}),
  ...(job.stdoutArtifact ? { artifact: job.stdoutArtifact } : {}),
});

const collectJobs = (
  ports: CompactionDurableEnvelopePorts,
): {
  liveJobs: EnvelopeJobState[];
  finishedJobs: EnvelopeJobState[];
} => {
  const liveJobs = ports.getRunningJobs().map(envelopeJob);
  const liveIds = new Set(liveJobs.map((job) => job.id));
  const finishedJobs = ports
    .getRecentJobs()
    .filter((job) => !liveIds.has(job.id))
    .map(envelopeJob);
  return { liveJobs, finishedJobs };
};

const build = async (
  ports: CompactionDurableEnvelopePorts,
): Promise<string | undefined> => {
  const plan = await ports.loadPlan().catch(() => undefined);
  const root = ports.getProjectRoot() ?? plan?.meta?.projectRoot;
  const consumed = consumedNotificationIds(ports.messages);
  const unread = [...ports.getUnreadNotificationIds()];
  const { liveJobs, finishedJobs } = collectJobs(ports);
  return buildDurableEnvelope({
    ...(plan ? { plan } : {}),
    outcome: ports.outcome,
    ledger: ports.ledger,
    ...(root ? { projectRoot: root } : {}),
    ...(root
      ? {
          packageManager:
            plan?.meta?.packageManager ?? ports.detectPackageManager(root),
        }
      : {}),
    responder: { unread, consumed },
    ...(liveJobs.length > 0 ? { liveJobs } : {}),
    ...(finishedJobs.length > 0 ? { finishedJobs } : {}),
  });
};

export const createCompactionDurableEnvelopeBuilder =
  (ports: CompactionDurableEnvelopePorts) => (): Promise<string | undefined> =>
    build(ports);
