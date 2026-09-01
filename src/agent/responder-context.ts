import type {
  BackgroundJob,
  ResponderNotification,
} from "../tools/jobs.js";

export const RESPONDER_CONTEXT_PREFIX = "RESPONDER / DURABLE JOB INBOX";
export const RESPONDER_RESULT_LEDGER_PREFIX =
  "RESPONDER RESULT LEDGER (authoritative consumed results)";

const MAX_LEDGER_ENTRIES = 32;

function oneLine(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function receiptPath(notification: ResponderNotification): string {
  return (
    notification.stdoutArtifact.chunks.at(-1) ??
    notification.stdoutArtifact.path
  );
}

export function responderContextMessage(input: {
  running: readonly BackgroundJob[];
  pending: readonly ResponderNotification[];
}): string | undefined {
  if (input.running.length === 0 && input.pending.length === 0) return undefined;
  const lines = [RESPONDER_CONTEXT_PREFIX];
  if (input.running.length > 0) {
    lines.push("Active monitored jobs:");
    for (const job of input.running.slice(0, 10)) {
      lines.push(
        `- job=${job.id} pid=${job.pid ?? "?"} status=${job.status}` +
          `${job.taskId ? ` task=${job.taskId}` : ""}` +
          `${job.parentTaskId ? ` parent=${job.parentTaskId}` : ""}` +
          ` command=${oneLine(job.commandDisplay)}`,
      );
    }
  }
  if (input.pending.length > 0) {
    lines.push("Unread completions (durable until job.read and persisted analysis):");
    for (const notification of input.pending.slice(0, 12)) {
      lines.push(
        `- notification=${notification.id} job=${notification.jobId} status=${notification.status}` +
          ` exit=${notification.exitCode ?? "?"}` +
          `${notification.signal ? ` signal=${notification.signal}` : ""}` +
          `${notification.taskId ? ` task=${notification.taskId}` : ""}` +
          `${notification.parentTaskId ? ` parent=${notification.parentTaskId}` : ""}` +
          ` stdout=${receiptPath(notification)}` +
          ` bytes=${notification.stdoutArtifact.bytes}` +
          ` stderr=${notification.stderrArtifact.path}`,
      );
    }
  }
  lines.push(
    "FIRE AND CONTINUE: after launching, move to the next task immediately. Do NOT sleep, shell.jobs-poll, repeat shell.tail, or fs.read the job log to watch progress — this inbox delivers each completion to you automatically at the next safe model boundary.",
    "PARENT-DONE RULE: a parent task is done when its own non-Responder work is done; Responder-owned child subtasks advance from the real process lifecycle — never mark, block on, or wait for them.",
    "TASK SETTLEMENT: Responder-owned tasks reconcile automatically from the latest authoritative job result after analysis. Do not call task.update for that child.",
    "MANDATORY READ RECEIPT: after analyzing a delivered completion and deciding its job is finished, call job.read with that job id or exact notification id. job.read is plan-independent, records delivered + read atomically, and is required before a final response. Do not create a plan merely to acknowledge a job.",
    "ON COMPLETION: extract only the key result lines with a filter or bounded shell.tail window, never a full noisy scanner log. Add evidence-driven follow-up tasks only when an active plan exists and the result requires them; otherwise report the result directly after job.read. Never launch a duplicate while a job is live.",
    "PARENT OWNERSHIP: when you delegate to the Responder, pass parentTaskId with the plan task id that owns the work (e.g. parentTaskId:\"t3\"). The child subtask is created under exactly that task; an unknown, completed, or Responder-owned id is rejected.",
    "DECLARED WAITS ONLY: never idle because a Responder job is running. If a foreground task genuinely cannot start until a child finishes, declare that child as its dependency when you add it; otherwise keep executing the next dependency-ready task and fold late results in as an addendum.",
    "FRAME COMMANDS TO PRESERVE THE KEY FIELDS: choose flags/output so the completed result still carries exactly what you need and little else — e.g. ffuf with -json (or a matcher on real codes, not a blanket -mc all), nmap -oX/-oG, grep -o for just the hits. Never run a command that discards the required signal.",
    "ONLY when every other non-report task is finished and nothing else remains may you call shell.jobs ONCE. If jobs are still live, STOP and report what you did plus which jobs are running — do not enter a sleep/poll/tail loop.",
  );
  return lines.join("\n");
}

export function isResponderResultLedgerMessage(message: {
  role: string;
  content: string;
}): boolean {
  return (
    message.role === "system" &&
    message.content.startsWith(RESPONDER_RESULT_LEDGER_PREFIX)
  );
}

export function responderResultLedgerEntry(
  notification: ResponderNotification,
): string {
  const analyzedAt =
    notification.analyzedAt ?? notification.readAt ?? new Date().toISOString();
  return (
    `- notification=${notification.id} job=${notification.jobId}` +
    ` status=${notification.status} consumed=true readAt=${notification.readAt ?? analyzedAt} analyzedAt=${analyzedAt}` +
    `${notification.taskId ? ` task=${notification.taskId}` : ""}` +
    `${notification.parentTaskId ? ` parent=${notification.parentTaskId}` : ""}` +
    ` artifact=${receiptPath(notification)}`
  );
}

export function upsertResponderResultLedger(
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
  notification: ResponderNotification,
): void {
  const entries: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!isResponderResultLedgerMessage(message)) continue;
    entries.unshift(
      ...message.content
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith("- notification=")),
    );
    messages.splice(index, 1);
  }
  const marker = `notification=${notification.id} `;
  const next = entries.filter((line) => !line.includes(marker));
  next.push(responderResultLedgerEntry(notification));
  messages.push({
    role: "system",
    content: `${RESPONDER_RESULT_LEDGER_PREFIX}\n${next
      .slice(-MAX_LEDGER_ENTRIES)
      .join("\n")}`,
  });
}

export function upsertResponderContextMessage(
  messages: Array<{ role: string; content: string }>,
  content: string | undefined,
): void {
  if (!content) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (
        message.role === "system" &&
        message.content.startsWith(RESPONDER_CONTEXT_PREFIX)
      ) {
        messages.splice(index, 1);
      }
    }
    return;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      message.content.startsWith(RESPONDER_CONTEXT_PREFIX)
    ) {
      if (message.content === content) return;
      break;
    }
  }
  messages.push({ role: "system", content });
}
