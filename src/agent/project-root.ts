import { isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionPlan } from "../store/plan.js";
import { safeCwd } from "../os/cwd.js";
import {
  isBareParentDirectory,
  isExistingProjectDir,
  resolveScaffoldTargetPath,
} from "./workspace-orient.js";

let activeProjectRoot: string | undefined;

export function setActiveProjectRoot(root: string | undefined): void {
  if (!root?.trim()) {
    activeProjectRoot = undefined;
    return;
  }
  const resolved = resolve(root.trim());
  if (isBareParentDirectory(resolved)) {
    return;
  }
  activeProjectRoot = resolved;
}

export function setActiveProjectRootIfValid(
  root: string | undefined,
  opts?: { force?: boolean },
): boolean {
  if (!root?.trim()) return false;
  const resolved = resolve(root.trim());
  if (isBareParentDirectory(resolved)) return false;
  if (!opts?.force && !existsSync(resolved)) return false;
  activeProjectRoot = resolved;
  return true;
}

export function getActiveProjectRoot(): string | undefined {
  return activeProjectRoot;
}

export function clearActiveProjectRoot(): void {
  activeProjectRoot = undefined;
}

const ABS_PROJECT_RE =
  /(?:^|[\s"'`=])(\/(?:Users|home)\/[^\s"'`:]+?(?:\/(?:Desktop|Documents|Projects|dev|code|src|work|repos?)\/[^\s"'`:]+|\/[^\s"'`:]*todo[^\s"'`/]*))(?=[\s"'`]|$)/gi;

export function extractProjectRootFromText(
  ...parts: string[]
): string | undefined {
  const blob = parts.filter(Boolean).join("\n");
  if (!blob.trim()) return undefined;

  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(ABS_PROJECT_RE.source, ABS_PROJECT_RE.flags);
  while ((m = re.exec(blob)) !== null) {
    const p = m[1]!.replace(/\/+$/, "");
    candidates.push(p);
  }

  const relDesk = blob.match(
    /(?:^|[\s"'`])(?:~\/Desktop|Desktop)\/([A-Za-z0-9._-]+)/,
  );
  if (relDesk?.[1]) {
    candidates.push(join(homedir(), "Desktop", relDesk[1]));
  }

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => b.length - a.length);

  const existing = candidates.filter((c) => existsSync(resolve(c)));
  const pool = existing.length > 0 ? existing : candidates;

  for (const c of pool) {
    const resolved = resolve(c);
    if (isBareParentDirectory(resolved) && pool.some((x) => x.length > c.length)) {
      continue;
    }
    if (isBareParentDirectory(resolved)) continue;
    return resolved;
  }
  return undefined;
}

export function extractProjectRootFromPlan(
  plan: SessionPlan | undefined,
): string | undefined {
  if (!plan) return undefined;
  if (plan.meta?.projectRoot?.trim()) {
    return resolve(plan.meta.projectRoot.trim());
  }
  return extractProjectRootFromText(
    plan.goal,
    plan.detail,
    ...plan.tasks.map((t) => t.title),
  );
}

export function extractProjectRootFromScaffold(
  command: string,
  shellCwd?: string,
): string | undefined {
  return resolveScaffoldTargetPath(command, shellCwd);
}

export function resolveToolPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return resolve(safeCwd(), ".");

  let expanded = trimmed;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }

  const root = getActiveProjectRoot();
  if (root) {
    return resolve(root, expanded);
  }
  return resolve(safeCwd(), expanded);
}

export function remapAgentCwdWrite(
  resolved: string,
  original: string,
): string {
  const root = getActiveProjectRoot();
  if (!root) return resolved;
  const agent = safeCwd();
  if (root === agent) return resolved;
  if (
    resolved === root ||
    resolved.startsWith(root + "/") ||
    resolved.startsWith(root + "\\") ||
    (isAbsolute(original.trim()) && existsSync(resolved))
  ) {
    return resolved;
  }
  if (
    !isAbsolute(original.trim()) &&
    (resolved.startsWith(agent + "/") || resolved.startsWith(agent + "\\"))
  ) {
    const rel = resolved.slice(agent.length).replace(/^[/\\]/, "");
    return resolve(root, rel);
  }
  if (
    (resolved.startsWith(agent + "/") || resolved.startsWith(agent + "\\")) &&
    existsSync(root) &&
    isExistingProjectDir(root)
  ) {
    const rel = resolved.slice(agent.length).replace(/^[/\\]+/, "");
    if (
      /^(src|lib|app|apps|packages|cmd|internal|pkg|tests?|spec|public|static|assets|components|pages|routes|handlers|models|views)[/\\]/i.test(
        rel,
      ) ||
      /\.(jsx?|tsx?|vue|svelte|py|go|rs|java|kt|rb|php|swift|cs)$/i.test(rel)
    ) {
      return resolve(root, rel);
    }
  }
  return resolved;
}
