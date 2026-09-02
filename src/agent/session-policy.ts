export interface SessionPolicy {
  allow: Set<string>;
  pentestAuthorized: { value: boolean };
  sessionId: string;
  planApproved: { value: boolean };
  pendingTaskBatch: { value: string | undefined };
  pendingDependency: { value: string | undefined };
}

export function createSessionPolicy(sessionId?: string): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
    sessionId:
      sessionId ??
      `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
    pendingTaskBatch: { value: undefined },
    pendingDependency: { value: undefined },
  };
}

const PRE_APPROVAL_ALLOWED_TOOLS = new Set<string>([
  "plan.create",
  "task.move",
  "job.read",
  "task.read",
  "task.update",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "tool.batch",
  "tool.check",
  "net.context",
  "web.search",
  "web.fetch",
  "dns.lookup",
  "whois.lookup",
  "http.fetch",
  "net.scan",
  "pentest.recon",
  "wordlist.find",
  "image.ocr",
  "pdf.read",
  "shell.jobs",
  "shell.tail",
  "shell.wait",
]);

const PLAN_MODE_BLOCKED_TOOLS = new Set<string>([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.append",
  "fs.replaceLines",
  "fs.delete",
]);

export function isPreApprovalAllowedTool(name: string): boolean {
  return PRE_APPROVAL_ALLOWED_TOOLS.has(name);
}

export function isPlanModeAllowedTool(name: string): boolean {
  if (PLAN_MODE_BLOCKED_TOOLS.has(name)) return false;
  return true;
}

export function isPlanModeAllowedShellCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  if (
    /\b(npm\s+create|npx\s+(?:--yes\s+)?create-|yarn\s+create|pnpm\s+create|bun\s+create|cargo\s+new|rails\s+new|poetry\s+new|flutter\s+create|django-admin\s+startproject|composer\s+create-project|npm\s+init\s+vite|create-next-app|create-react-app)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (
    /\b(fs\.write|tee\s+>|>>\s*\/|cat\s*>\s*|printf\s+.*>\s*)/i.test(c) &&
    !/\b(tee\s+\/tmp|tee\s+\$\{?TMP|>>\s*\/tmp|\/var\/folders)\b/i.test(c)
  ) {
    if (!/\b(\/tmp|TMPDIR|scratch|\.clai\/outputs)\b/i.test(c)) {
      return false;
    }
  }
  if (
    /\b(msfconsole|msfvenom|metasploit|exploit\/|use\s+exploit|revshell|reverse\s+shell|nc\s+-[el].*\d|ncat\s+-[el]|bash\s+-i\s+>&\s*\/dev\/tcp)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (
    /\b(sqlmap\b.*(?:--os-shell|--os-pwn|--sql-shell|--crawl)|hydra\s+.+\s+-l\s|medusa\s+.*-M\s)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (/\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r).*(\/|~)/i.test(c)) {
    return false;
  }
  return true;
}

export function isPlanApprovedByStatus(status: PlanStatusLike): boolean {
  return status !== "draft";
}

export function planHasOpenWork(status: PlanStatusLike | undefined): boolean {
  return status !== undefined && status !== "completed";
}

type PlanStatusLike = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function shouldEnableImageOcr(
  prompt: string,
  hasAttachedImages: boolean,
  visionProven = true,
): boolean {
  if (!hasAttachedImages) return true;
  if (!visionProven) return true;
  return /\b(?:ocr|optical character recognition|tesseract)\b/i.test(prompt);
}
