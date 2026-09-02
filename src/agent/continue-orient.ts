
import type { SessionPlan } from "../store/plan.js";
import type { ChatMessage } from "../types.js";
import type { BackgroundJob } from "../tools/jobs.js";

export const CONTINUE_ORIENT_PREFIX = "CONTINUE / RECOVER MID-WORK";

export function looksLikeContinueOrResumePrompt(prompt: string): boolean {
  const t = prompt.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (
    /^(?:continue|resume|proceed|keep\s+going|go\s+on|finish(?:\s+it)?|next|try\s+again|retry|pick\s+up)(?:\s+please)?[.!]?$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /^(?:continue|resume|proceed|keep\s+going|go\s+on|finish|retry|try\s+again)\b.{0,80}$/i.test(
      t,
    ) &&
    t.length < 100
  ) {
    return true;
  }
  if (
    /\b(?:continue\s+(?:from|where|the)|resume\s+(?:from|where|the)|pick\s+up\s+where|where\s+you\s+left\s+off|after\s+(?:the\s+)?(?:error|failure|timeout|interrupt))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

export interface ContinueOrientInput {
  readonly prompt: string;
  readonly history?: readonly ChatMessage[] | undefined;
  readonly plan?: SessionPlan | undefined;
  readonly runningJobs?: readonly BackgroundJob[] | undefined;
  readonly recentJobs?: readonly BackgroundJob[] | undefined;
  readonly informationalQuery?: boolean | undefined;
  readonly idleOrSocial?: boolean | undefined;
  readonly previousTurn?: PreviousTurnSignal | undefined;
}

export interface PreviousTurnSignal {
  readonly status:
    | "succeeded"
    | "partial"
    | "blocked"
    | "failed"
    | "aborted"
    | "paused_budget"
    | "error";
  readonly reason?: string | undefined;
}

const UNFINISHED_PREVIOUS_STATUSES = new Set([
  "partial",
  "blocked",
  "failed",
  "aborted",
  "paused_budget",
  "error",
]);

export function previousTurnUnfinished(
  signal: PreviousTurnSignal | undefined,
): boolean {
  return signal !== undefined && UNFINISHED_PREVIOUS_STATUSES.has(signal.status);
}

function startsNewDirection(prompt: string): boolean {
  return /\b(?:new\s+(?:task|plan|feature)|start\s+over|from\s+scratch|ignore\s+(?:the\s+)?(?:plan|previous)|different\s+(?:target|project))\b/i.test(
    prompt,
  );
}

export interface RecentToolHint {
  readonly name: string;
  readonly ok?: boolean | undefined;
  readonly head: string;
}

export function extractRecentToolHints(
  history: readonly ChatMessage[] | undefined,
  limit = 6,
): RecentToolHint[] {
  if (!history?.length) return [];
  const out: RecentToolHint[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = history[i]!;
    if (m.role !== "tool") continue;
    const name = m.name?.trim() || guessToolName(m.content) || "tool";
    const first =
      m.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    out.push({
      name,
      ...(typeof m.ok === "boolean" ? { ok: m.ok } : {}),
      head: oneLine(first, 140),
    });
  }
  return out.reverse();
}

function guessToolName(content: string): string | undefined {
  const m = content.match(/^Tool\s+(\S+)\s+result/i);
  return m?.[1];
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function jobLine(job: BackgroundJob): string {
  const cmd = oneLine(job.commandDisplay || job.command, 70);
  const exit =
    job.exitCode !== undefined && job.exitCode !== null
      ? ` exit=${job.exitCode}`
      : "";
  return `[${job.id}] ${job.status}${exit} — ${cmd}`;
}

export function shouldInjectContinueOrientation(
  input: ContinueOrientInput,
): boolean {
  if (input.informationalQuery || input.idleOrSocial) return false;
  if (looksLikeContinueOrResumePrompt(input.prompt)) return true;
  if (
    previousTurnUnfinished(input.previousTurn) &&
    !startsNewDirection(input.prompt)
  ) {
    return true;
  }

  const hasHistory = (input.history?.length ?? 0) >= 2;
  if (!hasHistory) return false;

  const openTask = input.plan?.tasks.some(
    (t) => t.state === "in_progress" || t.state === "failed",
  );
  const liveJobs = (input.runningJobs?.length ?? 0) > 0;
  if ((openTask || liveJobs) && input.prompt.trim().length < 160) {
    if (startsNewDirection(input.prompt)) return false;
    if (
      /^(?:ok|okay|yes|y|go|do\s+it|keep\s+going|and\s+then|what\s+next|now\s+what)[.!]?$/i.test(
        input.prompt.trim(),
      ) ||
      looksLikeContinueOrResumePrompt(input.prompt)
    ) {
      return true;
    }
  }
  return false;
}

export function buildContinueOrientation(input: ContinueOrientInput): string {
  if (!shouldInjectContinueOrientation(input)) return "";

  const previous = input.previousTurn;
  const lines: string[] = [
    CONTINUE_ORIENT_PREFIX,
    previousTurnUnfinished(previous)
      ? `The previous turn ended ${previous!.status}${previous!.reason ? ` (${oneLine(previous!.reason, 120)})` : ""}: its work is unfinished.`
      : "The prior turn may have been interrupted (provider error, timeout, user cancel, or a long job still running).",
    "Re-attach to real work before advancing the plan. Do not mark tasks done or skip ahead without fresh evidence from tools this turn.",
    "Do not repeat completed steps: check plan task states, background jobs and saved artifacts first, and reuse their results.",
  ];

  const plan = input.plan;
  if (plan) {
    const open = plan.tasks.filter((t) => t.state === "in_progress");
    const failed = plan.tasks.filter((t) => t.state === "failed");
    const pending = plan.tasks.filter((t) => t.state === "pending");
    lines.push(
      `Plan goal: ${oneLine(plan.goal, 120)} (status=${plan.status}, kind=${plan.kind ?? "?"})`,
    );
    if (open.length) {
      lines.push(
        `In progress: ${open.map((t) => `[${t.id}] ${oneLine(t.title, 60)}`).join("; ")}`,
      );
    }
    if (failed.length) {
      lines.push(
        `Failed (retry with evidence, do not skip): ${failed.map((t) => `[${t.id}] ${oneLine(t.title, 50)}`).join("; ")}`,
      );
    }
    if (pending.length) {
      lines.push(
        `Pending (only after current open work is honestly finished): ${pending
          .slice(0, 6)
          .map((t) => `[${t.id}] ${oneLine(t.title, 40)}`)
          .join("; ")}`,
      );
    }
  }

  const running = input.runningJobs ?? [];
  const recent = input.recentJobs ?? [];
  if (running.length) {
    lines.push("Live background jobs (check before starting the same work again):");
    for (const j of running.slice(0, 8)) lines.push(`  ${jobLine(j)}`);
  } else if (recent.length) {
    const interesting = recent
      .filter((j) =>
        /ffuf|nmap|nuclei|gobuster|ferox|masscan|hydra|sqlmap|cargo|npm|vite|next|pytest|jest|docker|make|build/i.test(
          j.commandDisplay || j.command,
        ),
      )
      .slice(0, 6);
    if (interesting.length) {
      lines.push("Recent jobs (may have finished while offline — tail before re-running):");
      for (const j of interesting) lines.push(`  ${jobLine(j)}`);
    }
  }

  const tools = extractRecentToolHints(input.history, 6);
  if (tools.length) {
    lines.push("Last tool results in context (do not invent outcomes):");
    for (const t of tools) {
      const ok =
        t.ok === true ? "ok" : t.ok === false ? "fail" : "?";
      lines.push(`  ${t.name} [${ok}]: ${t.head}`);
    }
  }

  const orderSteps: string[] = ["Suggested order (adapt to evidence):"];
  if (plan) {
    orderSteps.push(
      "1) Re-read the ACTIVE PLAN task states above first — they are the current source of truth for tracked task status, not proof that a higher-level roadmap is exhausted. If the user explicitly requested the entire roadmap/program or all phases, reconcile against the referenced roadmap/phase/index files before treating the last tracked task as completion and append omitted work with task.add.",
      "2) Open the in_progress / failed task and read only its own artifacts plus the earlier-task outputs you need to confirm what is already done — before scanning unrelated files.",
      "3) If long jobs were running, shell.jobs then shell.tail the relevant ids (or read saved artifacts) to harvest results before redoing that work.",
      "4) Resume the task with real tools; mark it done only with fresh proof, then open the next pending task.",
      "Do not skip ahead, do not finalize while tasks remain, and avoid busy-wait loops (sleep/poll with no progress).",
    );
  } else {
    orderSteps.push(
      "1) shell.jobs — see what is still running or just finished.",
      "2) shell.tail on relevant job ids (or read saved artifacts) — harvest results before new work.",
      "3) Resume the interrupted work with real tools; confirm each outcome from actual results, not assumptions.",
      "Avoid busy-wait loops (sleep/poll with no progress). Prefer background long jobs + other useful work, then tail.",
    );
  }
  lines.push(...orderSteps);

  return lines.join("\n");
}
