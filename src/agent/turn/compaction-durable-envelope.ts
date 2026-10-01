import type { ChatMessage } from "../../types.js";
import type { OutcomeEnvelope } from "../outcomes.js";
import type { SessionPlan } from "../../store/plan.js";
import type { SubagentRun } from "../subagents/types.js";
import {
  buildDurableEnvelope,
  isDurableEnvelopeContent,
  type DurableEnvelopeInput,
  type EnvelopeJobState,
  type EnvelopeSubagentState,
  type ResultConclusion,
  type WorkLedger,
} from "../durable-envelope.js";
import { collectUserCredentials } from "../context/user-credentials.js";
import {
  isResponderResultLedgerMessage,
  parseResponderLedgerLine,
} from "../responder-context.js";

export interface CompactionEnvelopeJob {
  readonly id: string;
  readonly status: string;
  readonly command: string;
  readonly commandDisplay: string;
  readonly name?: string | undefined;
  readonly taskId?: string | undefined;
  readonly stdoutArtifact?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly responder?: boolean | undefined;
}

export interface CompactionEnvelopeNotification {
  readonly id: string;
  readonly jobId: string;
}

export interface CompactionDurableEnvelopePorts {
  readonly messages: readonly ChatMessage[];
  readonly outcome?: OutcomeEnvelope | undefined;
  readonly ledger?: WorkLedger | undefined;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly getProjectRoot: () => string | undefined;
  readonly detectPackageManager: (root: string) => string | undefined;
  readonly getPendingNotifications: () => readonly CompactionEnvelopeNotification[];
  readonly getRunningJobs: () => readonly CompactionEnvelopeJob[];
  readonly getRecentJobs: () => readonly CompactionEnvelopeJob[];
  readonly getSubagents: () => readonly SubagentRun[];
}

interface ConsumedResults {
  readonly notifications: readonly string[];
  readonly jobs: readonly string[];
  readonly conclusions: readonly ResultConclusion[];
}

const consumedResults = (messages: readonly ChatMessage[]): ConsumedResults => {
  const notifications = new Set<string>();
  const jobs = new Set<string>();
  const conclusions = new Map<string, string>();
  for (const message of messages) {
    if (!isResponderResultLedgerMessage(message)) continue;
    for (const line of message.content.split("\n")) {
      const { notificationId, jobId, digest } = parseResponderLedgerLine(line);
      if (!notificationId) continue;
      notifications.add(notificationId);
      if (!jobId) continue;
      jobs.add(jobId);
      if (digest) conclusions.set(jobId, digest);
      else conclusions.delete(jobId);
    }
  }
  return {
    notifications: [...notifications],
    jobs: [...jobs],
    conclusions: [...conclusions].map(([jobId, conclusion]) => ({ jobId, conclusion })),
  };
};

const envelopeJob = (job: CompactionEnvelopeJob): EnvelopeJobState => ({
  id: job.id,
  status: job.status,
  command: job.commandDisplay || job.command,
  ...(job.name ? { name: job.name } : {}),
  ...(job.taskId ? { taskId: job.taskId } : {}),
  ...(job.stdoutArtifact ? { artifact: job.stdoutArtifact } : {}),
  ...(typeof job.exitCode === "number" ? { exitCode: job.exitCode } : {}),
  ...(job.responder ? { responder: true } : {}),
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

const findingsDigest = (report: string | undefined): string | undefined => {
  if (!report?.trim()) return undefined;
  const findings = report.split(/^## /m).find((section) => /^findings\b/i.test(section));
  const body = (findings
    ? findings.replace(/^findings[^\n]*\n?/i, "")
    : report.replace(/^\s*Status:[^\n]*\n?/i, ""))
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return body || undefined;
};

const subagentResult = (run: SubagentRun): EnvelopeSubagentState["result"] => {
  if (run.status === "running" || run.status === "stopping") return "running";
  if (!run.report && !run.lastKnownSummary?.report) return "none";
  return run.resultAcknowledged ? "read" : "unread";
};

const envelopeSubagent = (run: SubagentRun): EnvelopeSubagentState => {
  const result = subagentResult(run);
  const digest =
    result === "read" ? findingsDigest(run.report ?? run.lastKnownSummary?.report) : undefined;
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    attempt: run.attempt,
    result,
    ...(digest ? { digest } : {}),
  };
};

export const collectCompactionEnvelopeInput = async (
  ports: CompactionDurableEnvelopePorts,
): Promise<DurableEnvelopeInput> => {
  const plan = await ports.loadPlan();
  const root = ports.getProjectRoot() ?? plan?.meta?.projectRoot;
  const consumed = consumedResults(ports.messages);
  const pending = ports.getPendingNotifications();
  const consumedIds = new Set(consumed.notifications);
  const unread = pending.filter((notification) => !consumedIds.has(notification.id));
  const { liveJobs, finishedJobs } = collectJobs(ports);
  const subagents = ports.getSubagents().map(envelopeSubagent);
  const credentials = collectUserCredentials(ports.messages, isDurableEnvelopeContent);
  return {
    ...(plan ? { plan } : {}),
    ...(ports.outcome ? { outcome: ports.outcome } : {}),
    ...(ports.ledger ? { ledger: ports.ledger } : {}),
    ...(root ? { projectRoot: root } : {}),
    ...(root
      ? {
          packageManager:
            plan?.meta?.packageManager ?? ports.detectPackageManager(root),
        }
      : {}),
    responder: {
      unread: unread.map((notification) => notification.id),
      consumed: consumed.notifications,
      unreadJobs: unread.map((notification) => notification.jobId),
      consumedJobs: consumed.jobs,
      ...(consumed.conclusions.length > 0 ? { conclusions: consumed.conclusions } : {}),
    },
    ...(liveJobs.length > 0 ? { liveJobs } : {}),
    ...(finishedJobs.length > 0 ? { finishedJobs } : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(credentials.length > 0 ? { credentials } : {}),
  };
};

const build = async (
  ports: CompactionDurableEnvelopePorts,
): Promise<string | undefined> =>
  buildDurableEnvelope(await collectCompactionEnvelopeInput(ports));

export const createCompactionDurableEnvelopeBuilder =
  (ports: CompactionDurableEnvelopePorts) => (): Promise<string | undefined> =>
    build(ports);
