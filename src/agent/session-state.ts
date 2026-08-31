
export const SESSION_STATE_PREFIX = "SESSION STATE / WORKING MEMORY";

export interface SessionStateSnapshot {
  goal?: string | undefined;
  projectRoot?: string | undefined;
  packageManager?: string | undefined;
  planStatus?: string | undefined;
  planKind?: string | undefined;
  openTask?: string | undefined;
  pendingTasks?: string[] | undefined;
  doneTasks?: string[] | undefined;
  featureAppRequired?: boolean | undefined;
  featureSeen?: boolean | undefined;
  scaffoldOk?: boolean | undefined;
  serverStarted?: boolean | undefined;
  serverProbedOk?: boolean | undefined;
  lastProbeFailed?: boolean | undefined;
  lastOkTool?: string | undefined;
  nextHint?: string | undefined;
  engagementNote?: string | undefined;
  backgroundJobs?: string | undefined;
}

export function buildSessionStateBlock(s: SessionStateSnapshot): string {
  const lines: string[] = [SESSION_STATE_PREFIX];
  if (s.goal) lines.push(`goal: ${oneLine(s.goal, 160)}`);
  if (s.projectRoot) lines.push(`project_root: ${s.projectRoot}`);
  if (s.packageManager) lines.push(`package_manager: ${s.packageManager}`);
  if (s.planStatus || s.planKind) {
    lines.push(
      `plan: ${s.planKind ?? "?"} status=${s.planStatus ?? "?"}`.trim(),
    );
  }
  if (s.openTask) lines.push(`open_task: ${oneLine(s.openTask, 120)}`);
  if (s.doneTasks?.length) {
    lines.push(`done: ${s.doneTasks.slice(0, 8).join("; ")}`);
  }
  if (s.pendingTasks?.length) {
    lines.push(`pending: ${s.pendingTasks.slice(0, 8).join("; ")}`);
  }
  const flags: string[] = [];
  if (s.featureAppRequired) {
    flags.push(`feature_needed=true feature_seen=${s.featureSeen ? "true" : "false"}`);
  }
  if (s.scaffoldOk) flags.push("scaffold_ok=true");
  if (s.serverStarted) flags.push("server_started=true");
  if (s.serverProbedOk) flags.push("probe_ok=true");
  if (s.lastProbeFailed) flags.push("last_probe_failed=true");
  if (flags.length) lines.push(`flags: ${flags.join(" ")}`);
  if (s.lastOkTool) lines.push(`last_ok_tool: ${s.lastOkTool}`);
  if (s.backgroundJobs) {
    lines.push(`jobs: ${oneLine(s.backgroundJobs, 200)}`);
  }
  if (s.engagementNote) lines.push(`note: ${oneLine(s.engagementNote, 160)}`);
  if (s.nextHint) lines.push(`next: ${oneLine(s.nextHint, 200)}`);
  lines.push(
    "Use this state. Prefer evidence over claims. Update work via tools; do not invent progress.",
  );
  return lines.join("\n");
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export function inferNextHint(s: SessionStateSnapshot): string | undefined {
  if (s.featureAppRequired && !s.featureSeen) {
    return "Implement the product feature (replace starter boilerplate); do not start the server yet.";
  }
  if (s.lastProbeFailed) {
    return "Fix the app error (fs.edit/write), then re-probe localhost — diagnosis alone is incomplete.";
  }
  if (
    s.serverStarted &&
    s.openTask &&
    /\bleave\s+.*running|for\s+user\s+to\s+test|keep\s+.*running/i.test(s.openTask)
  ) {
    return "Runtime already proven: confirm still alive if needed, task.update done, report URL + port + job id — do not restart.";
  }
  if (s.serverStarted && !s.serverProbedOk && !s.lastProbeFailed) {
    return "Confirm ready (shell.tail or lsof LISTEN or localhost GET); leave server running; report URL + job id. Do not thrash ports.";
  }
  if (s.backgroundJobs && /\brunning\b/i.test(s.backgroundJobs)) {
    return "Background jobs still running: shell.jobs / shell.tail first; harvest results before marking tasks done or starting duplicates.";
  }
  if (s.openTask && /\brecon|enumerat|scan|dns|nmap|fuzz|ffuf/i.test(s.openTask)) {
    return "Finish open recon/fuzz with tools (or tail jobs), then mark done with evidence — do not skip to later tasks.";
  }
  if (s.openTask) {
    return `Finish open task, verify with tools, mark done only with evidence — do not jump to later pending tasks.`;
  }
  if (s.pendingTasks?.length) {
    return `Open next pending task with task.update in_progress, then execute it.`;
  }
  return undefined;
}

export function isSessionStateMessage(content: string): boolean {
  return content.startsWith(SESSION_STATE_PREFIX);
}

export function upsertSessionStateMessage(
  messages: Array<{ role: string; content: string }>,
  block: string,
): void {
  const content = block.startsWith(SESSION_STATE_PREFIX)
    ? block
    : `${SESSION_STATE_PREFIX}\n${block}`;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith(SESSION_STATE_PREFIX)
    ) {
      messages.splice(i, 1);
    }
  }

  messages.push({ role: "system", content });
}
