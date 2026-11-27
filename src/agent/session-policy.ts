import type { SubagentManager } from "./subagents/manager.js";

export interface SessionPolicy {
  subagents?: SubagentManager;
  allow: Set<string>;
  pentestAuthorized: { value: boolean };
  sessionId: string;
  compactPromptModes?: Map<string, boolean>;
  planApproved: { value: boolean };
}

export function createSessionPolicy(sessionId?: string): SessionPolicy {
  return {
    allow: new Set(),
    compactPromptModes: new Map(),
    pentestAuthorized: { value: false },
    sessionId:
      sessionId ??
      `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
  };
}

const PRE_APPROVAL_ALLOWED_TOOLS = new Set<string>([
  "plan.create",
  "task.move",
  "job.read",
  "task.update",
  "fs.read",
  "web.search",
  "web.fetch",
  "http.fetch",
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

const QUOTED_TEXT = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const HARMLESS_REDIRECT = /(?:\d*|&)>>?\s*\/dev\/null\b|\d*>&\s*-?\d+\b|\d*>&-/g;
const OUTPUT_REDIRECT = /(?:\d*|&)>>?[&|]?\s*([^\s;|&()<>]+)/g;
const TEE_ARGS = /\btee\b((?:\s+[^\s;|&()<>]+)*)/g;
const SCRATCH_TARGET =
  /^(?:\/dev\/null$|\/dev\/std(?:out|err)$|\/(?:private\/)?tmp\/|\/var\/folders\/|\$\{?TMP(?:DIR)?\}?\/|\S*\.clai\/outputs\/)/;

function shellWriteTargets(command: string): string[] {
  const bare = command.replace(QUOTED_TEXT, '""').replace(HARMLESS_REDIRECT, " ");
  const redirects = [...bare.matchAll(OUTPUT_REDIRECT)].map((match) => match[1]!);
  const teed = [...bare.matchAll(TEE_ARGS)].flatMap((match) =>
    (match[1] ?? "").trim().split(/\s+/).filter((arg) => arg && !arg.startsWith("-")),
  );
  return [...redirects, ...teed];
}

function writesOutsideScratch(command: string): boolean {
  return shellWriteTargets(command).some((target) => !SCRATCH_TARGET.test(target));
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
  if (/\bfs\.write/i.test(c) || writesOutsideScratch(c)) return false;
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
