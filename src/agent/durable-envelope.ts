import { relative } from "node:path";
import type { ToolCall } from "../types.js";
import type { OutcomeEnvelope } from "./outcomes.js";
import { scratchWriteTargetPaths } from "./scratch-write.js";
import {
  foregroundActiveTask,
  foregroundRemaining,
  foregroundTasks,
  type SessionPlan,
} from "../store/plan.js";
import { renderUserCredentials } from "./context/user-credentials.js";
import { MAX_RESULT_DIGEST_CHARS } from "./responder-context.js";

export const DURABLE_ENVELOPE_PREFIX = "DURABLE WORK ENVELOPE";

const MAX_LIST_ENTRIES = 20;
const MAX_STATEMENT_CHARS = 180;
const SUBAGENT_DIGEST_CHARS = 240;

export type FileMutationKind = "created" | "modified" | "deleted";

const MUTATION_KIND_BY_TOOL: ReadonlyMap<string, FileMutationKind> = new Map([
  ["fs.write", "created"],
  ["fs.writeMany", "created"],
  ["fs.edit", "modified"],
  ["fs.replaceLines", "modified"],
  ["fs.append", "modified"],
  ["fs.delete", "deleted"],
]);

export class WorkLedger {
  private readonly files = new Map<string, FileMutationKind>();
  private readonly artifacts = new Set<string>();

  recordToolCall(call: ToolCall, ok: boolean, artifactPath?: string): void {
    if (artifactPath) this.artifacts.add(artifactPath);
    if (!ok) return;
    const kind = MUTATION_KIND_BY_TOOL.get(call.name);
    if (!kind) return;
    for (const path of scratchWriteTargetPaths(call)) {
      const existing = this.files.get(path);
      if (kind === "deleted" || existing === undefined) {
        this.files.set(path, kind);
      }
    }
  }

  pathsByKind(kind: FileMutationKind): string[] {
    return [...this.files.entries()]
      .filter(([, value]) => value === kind)
      .map(([path]) => path);
  }

  artifactPaths(): string[] {
    return [...this.artifacts];
  }

  get size(): number {
    return this.files.size + this.artifacts.size;
  }
}

export interface ResultConclusion {
  readonly jobId: string;
  readonly conclusion: string;
}

export interface ResponderEnvelopeState {
  readonly unread: readonly string[];
  readonly consumed: readonly string[];
  readonly unreadJobs?: readonly string[] | undefined;
  readonly consumedJobs?: readonly string[] | undefined;
  readonly conclusions?: readonly ResultConclusion[] | undefined;
}

export interface EnvelopeJobState {
  readonly id: string;
  readonly status: string;
  readonly command: string;
  readonly name?: string | undefined;
  readonly taskId?: string | undefined;
  readonly artifact?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly responder?: boolean | undefined;
}

export interface EnvelopeSubagentState {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly attempt: number;
  readonly result: "running" | "read" | "unread" | "none";
  readonly digest?: string | undefined;
}

export interface DurableEnvelopeInput {
  readonly plan?: SessionPlan | undefined;
  readonly outcome?: OutcomeEnvelope | undefined;
  readonly ledger?: WorkLedger | undefined;
  readonly responder?: ResponderEnvelopeState | undefined;
  readonly liveJobs?: readonly EnvelopeJobState[] | undefined;
  readonly finishedJobs?: readonly EnvelopeJobState[] | undefined;
  readonly projectRoot?: string | undefined;
  readonly packageManager?: string | undefined;
  readonly scopeSummary?: string | undefined;
  readonly subagents?: readonly EnvelopeSubagentState[] | undefined;
  readonly credentials?: readonly string[] | undefined;
}

function omittedNote(total: number, shown: number, noun: string): string | undefined {
  const hidden = total - shown;
  return hidden > 0 ? `(+${hidden} earlier ${noun} omitted)` : undefined;
}

function clip(text: string, max = MAX_STATEMENT_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function renderList(paths: readonly string[], root?: string | undefined): string {
  const shown = paths.slice(0, MAX_LIST_ENTRIES).map((path) => {
    if (!root) return path;
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") ? rel : path;
  });
  const overflow = paths.length - shown.length;
  return overflow > 0
    ? `${shown.join(", ")} (+${overflow} more)`
    : shown.join(", ");
}

function planLines(plan: SessionPlan, lines: string[]): void {
  const foreground = foregroundTasks(plan);
  const active = foregroundActiveTask(plan);
  const remaining = foregroundRemaining(plan);
  lines.push(
    `Plan ${plan.sessionId} (${plan.status}): ${clip(plan.goal || "(no goal)")} — ${foreground.length - remaining.length}/${foreground.length} foreground tasks done`,
  );
  if (active) {
    lines.push(`Active foreground task: ${active.id} ${clip(active.title)}`);
  }
  const next = remaining.find((task) => task.id !== active?.id);
  if (next) lines.push(`Next foreground task: ${next.id} ${clip(next.title)}`);
}

function responderResult(
  jobId: string,
  responder: ResponderEnvelopeState | undefined,
): string {
  if (responder?.consumedJobs?.includes(jobId)) return ", result read";
  if (responder?.unreadJobs?.includes(jobId)) return ", result unread";
  return "";
}

function responderTaskLines(input: DurableEnvelopeInput, lines: string[]): void {
  const delegated = (input.plan?.tasks ?? []).filter((task) => task.responderOwned);
  if (delegated.length === 0) return;
  const jobs = new Map(
    [...(input.finishedJobs ?? []), ...(input.liveJobs ?? [])].map((job) => [job.id, job]),
  );
  const shownTasks = delegated.slice(-MAX_LIST_ENTRIES);
  const omittedTasks = omittedNote(delegated.length, shownTasks.length, "tasks");
  const rendered = shownTasks.map((task) => {
    const parent = task.parentTaskId ? ` parent=${task.parentTaskId}` : "";
    const job = task.jobId ? jobs.get(task.jobId) : undefined;
    const exit = job?.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
    const linked = task.jobId
      ? ` job=${task.jobId}${job ? ` ${job.status}${exit}` : ""}${responderResult(task.jobId, input.responder)}`
      : "";
    return `[${task.id}] ${clip(task.title, 90)} (${task.state})${parent}${linked}`;
  });
  lines.push(
    `Responder-delegated tasks (results arrive in the inbox; job.read acknowledges one): ${[omittedTasks, ...rendered].filter(Boolean).join("; ")}`,
  );
}

function conclusionLines(
  responder: ResponderEnvelopeState | undefined,
  lines: string[],
): void {
  const entries = responder?.conclusions ?? [];
  if (entries.length === 0) return;
  const shown = entries.slice(-MAX_LIST_ENTRIES);
  const omitted = omittedNote(entries.length, shown.length, "conclusions");
  lines.push(
    "Result conclusions (recorded when each result was read; rely on these instead of re-reading):",
    ...(omitted ? [`- ${omitted}`] : []),
    ...shown.map(
      ({ jobId, conclusion }) => `- [${jobId}] ${clip(conclusion, MAX_RESULT_DIGEST_CHARS)}`,
    ),
  );
}

const SUBAGENT_RESULT_NOTE: Readonly<Record<EnvelopeSubagentState["result"], string>> = {
  running: "",
  read: ", result read",
  unread: ", result pending delivery",
  none: ", no usable result",
};

function subagentLines(
  subagents: readonly EnvelopeSubagentState[] | undefined,
  lines: string[],
): void {
  if (!subagents?.length) return;
  const shown = subagents.slice(-MAX_LIST_ENTRIES);
  const omitted = omittedNote(subagents.length, shown.length, "runs");
  lines.push(
    'Subagents (subagent.read {id, view:"summary"} recovers a result; view:"report" pages the full report):',
    ...(omitted ? [`- ${omitted}`] : []),
    ...shown.map((run) => {
      const digest = run.digest ? ` — ${clip(run.digest, SUBAGENT_DIGEST_CHARS)}` : "";
      return `- [${run.id}] ${clip(run.title, 90)} (${run.status}, attempt ${run.attempt}${SUBAGENT_RESULT_NOTE[run.result]})${digest}`;
    }),
  );
}

function outcomeLines(outcome: OutcomeEnvelope, lines: string[]): void {
  const proven = outcome.outcome.criteria.filter(
    (criterion) => criterion.status === "proven",
  );
  const unresolved = outcome.outcome.criteria.filter(
    (criterion) =>
      criterion.status === "unproven" ||
      criterion.status === "supported" ||
      criterion.status === "refuted",
  );
  lines.push(`Outcome ${outcome.outcome.kind}: ${outcome.outcome.status}`);
  if (proven.length > 0) {
    lines.push(
      `Proven criteria: ${proven.map((c) => `${c.id} ${clip(c.statement, 80)}`).slice(0, MAX_LIST_ENTRIES).join("; ")}`,
    );
  }
  if (unresolved.length > 0) {
    lines.push(
      `Unresolved criteria: ${unresolved
        .map((c) => `${c.id} (${c.status}${c.required ? ", required" : ""}) ${clip(c.statement, 80)}`)
        .slice(0, MAX_LIST_ENTRIES)
        .join("; ")}`,
    );
  }
  const passes = outcome.evidence.filter((record) => record.result === "pass");
  if (passes.length > 0) {
    const recent = passes.slice(-MAX_LIST_ENTRIES);
    lines.push(
      `Verified checks: ${recent.map((record) => `${record.source.tool} ${clip(record.observation, 70)}`).join("; ")}`,
    );
  }
  if (outcome.failedHypotheses.length > 0) {
    const recent = outcome.failedHypotheses.slice(-MAX_LIST_ENTRIES);
    lines.push(
      `Failed approaches (do not repeat): ${recent.map((entry) => `${entry.signature} — ${clip(entry.premise, 90)}`).join("; ")}`,
    );
  }
  const completed = outcome.completedOperations ?? [];
  if (completed.length > 0) {
    lines.push(
      `Completed read-only operations (do not repeat identical calls): ${completed
        .slice(-MAX_LIST_ENTRIES)
        .map((entry) => `${entry.signature} ${clip(entry.summary, 90)} — ${clip(entry.observation, 80)}${entry.artifact ? ` artifact=${entry.artifact}` : ""}`)
        .join("; ")}`,
    );
  }
}

function renderJob(job: EnvelopeJobState): string {
  const name = job.name ? ` "${clip(job.name, 60)}"` : "";
  const responder = job.responder ? " responder" : "";
  const exit = job.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
  const task = job.taskId ? ` task=${job.taskId}` : "";
  const artifact = job.artifact ? ` artifact=${job.artifact}` : "";
  return `[${job.id}]${name} ${job.status}${exit}${responder}${task} — ${clip(job.command, 90)}${artifact}`;
}

function jobLines(input: DurableEnvelopeInput, lines: string[]): void {
  const live = input.liveJobs ?? [];
  const finished = input.finishedJobs ?? [];
  if (live.length > 0) {
    const shown = live.slice(0, MAX_LIST_ENTRIES);
    lines.push(
      `Live background jobs (do not relaunch; shell.tail {id} reads a regular job, responder jobs report through the inbox): ${[...shown.map(renderJob), omittedNote(live.length, shown.length, "jobs")].filter(Boolean).join("; ")}`,
    );
  }
  if (finished.length > 0) {
    const shown = finished.slice(0, MAX_LIST_ENTRIES);
    lines.push(
      `Finished background jobs (harvest output before redoing the work): ${[...shown.map(renderJob), omittedNote(finished.length, shown.length, "jobs")].filter(Boolean).join("; ")}`,
    );
  }
}

export function buildDurableEnvelope(
  input: DurableEnvelopeInput,
): string | undefined {
  const lines: string[] = [];
  if (input.projectRoot) {
    lines.push(
      `Project root: ${input.projectRoot}${input.packageManager ? ` (package manager: ${input.packageManager})` : ""}`,
    );
  }
  if (input.scopeSummary) lines.push(`Engagement scope: ${clip(input.scopeSummary, 240)}`);
  if (input.plan) planLines(input.plan, lines);
  if (input.outcome) outcomeLines(input.outcome, lines);
  if (input.responder) {
    if (input.responder.unread.length > 0) {
      lines.push(`Unread responder results: ${input.responder.unread.join(", ")}`);
    }
    if (input.responder.consumed.length > 0) {
      lines.push(
        `Consumed responder results (never re-read): ${input.responder.consumed.join(", ")}`,
      );
    }
  }
  conclusionLines(input.responder, lines);
  jobLines(input, lines);
  responderTaskLines(input, lines);
  subagentLines(input.subagents, lines);
  const ledger = input.ledger;
  if (ledger && ledger.size > 0) {
    const created = ledger.pathsByKind("created");
    const modified = ledger.pathsByKind("modified");
    const deleted = ledger.pathsByKind("deleted");
    const artifacts = ledger.artifactPaths();
    if (created.length > 0) {
      lines.push(`Files created: ${renderList(created, input.projectRoot)}`);
    }
    if (modified.length > 0) {
      lines.push(`Files modified: ${renderList(modified, input.projectRoot)}`);
    }
    if (deleted.length > 0) {
      lines.push(`Files deleted: ${renderList(deleted, input.projectRoot)}`);
    }
    if (artifacts.length > 0) {
      lines.push(`Artifacts on disk: ${renderList(artifacts)}`);
    }
  }
  lines.push(...renderUserCredentials(input.credentials ?? []));
  if (lines.length === 0) return undefined;
  return [
    `${DURABLE_ENVELOPE_PREFIX} (canonical; authoritative over summarized narrative)`,
    ...lines,
  ].join("\n");
}

export function isDurableEnvelopeContent(content: string): boolean {
  return content.startsWith(DURABLE_ENVELOPE_PREFIX);
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function summarizeCarriedWork(
  input: DurableEnvelopeInput,
): string | undefined {
  const subagents = input.subagents ?? [];
  const delegated = (input.plan?.tasks ?? []).filter((task) => task.responderOwned);
  const conclusions = input.responder?.conclusions?.length ?? 0;
  const parts = [
    subagents.length > 0
      ? `${plural(subagents.length, "subagent")} (${subagents.filter((run) => run.result === "read").length} read)`
      : undefined,
    (input.liveJobs?.length ?? 0) > 0
      ? plural(input.liveJobs!.length, "live job")
      : undefined,
    (input.finishedJobs?.length ?? 0) > 0
      ? plural(input.finishedJobs!.length, "finished job")
      : undefined,
    delegated.length > 0 ? plural(delegated.length, "delegated task") : undefined,
    (input.responder?.consumed.length ?? 0) > 0
      ? `${plural(input.responder!.consumed.length, "responder result")} read (${conclusions} with a conclusion)`
      : undefined,
    (input.credentials?.length ?? 0) > 0
      ? plural(input.credentials!.length, "credential")
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
