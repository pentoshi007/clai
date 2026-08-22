import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { frontmatterList, parseFrontmatter } from "./frontmatter.js";
import type { SkillMeta, SkillRoot } from "./types.js";

const SKILL_FILE_NAMES: readonly string[] = ["SKILL.md", "skill.md", "Skill.md"];
const METADATA_HEAD_BYTES = 8 * 1024;
const MAX_SKILLS_PER_ROOT = 120;
const MAX_TOTAL_SKILLS = 300;
const MAX_DESCRIPTION_CHARS = 420;
const MAX_ENTRIES_PER_DIR = 400;
const MAX_NESTING_DEPTH = 3;
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
]);

export function normalizeSkillName(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned.length > 64) return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) return undefined;
  return cleaned;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function descriptionFromBody(body: string): string {
  for (const block of body.split(/\n{2,}/)) {
    const candidate = collapse(
      block
        .replace(/^#{1,6}\s+.*$/gm, "")
        .replace(/^[>*-]\s+/gm, "")
        .replace(/`{1,3}/g, ""),
    );
    if (candidate.length >= 24) return clip(candidate, 220);
  }
  return "";
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function resolveSkillFile(dir: string): Promise<string | undefined> {
  for (const candidate of SKILL_FILE_NAMES) {
    const path = join(dir, candidate);
    try {
      const info = await stat(path);
      if (info.isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readSkillMeta(
  dir: string,
  file: string,
  root: SkillRoot,
): Promise<SkillMeta | undefined> {
  let head: string;
  try {
    head = await readHead(file, METADATA_HEAD_BYTES);
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(head);
  const declared = parsed.fields.name;
  const name =
    (declared ? normalizeSkillName(declared) : undefined) ??
    normalizeSkillName(basename(dir));
  if (!name) return undefined;
  const description =
    clip(collapse(parsed.fields.description ?? ""), MAX_DESCRIPTION_CHARS) ||
    descriptionFromBody(parsed.body);
  if (!description) return undefined;
  const allowedTools = frontmatterList(parsed, "allowed-tools");
  const compatibility = parsed.fields.compatibility
    ? clip(collapse(parsed.fields.compatibility), 200)
    : undefined;
  const license = parsed.fields.license
    ? clip(collapse(parsed.fields.license), 80)
    : undefined;
  return {
    name,
    description,
    dir,
    file,
    scope: root.scope,
    tool: root.tool,
    root: root.path,
    ...(compatibility ? { compatibility } : {}),
    ...(license ? { license } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

async function scanDirectory(
  dir: string,
  root: SkillRoot,
  depth: number,
  budget: { remaining: number },
  out: SkillMeta[],
): Promise<void> {
  if (depth > MAX_NESTING_DEPTH || budget.remaining <= 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .slice(0, MAX_ENTRIES_PER_DIR);
  for (const entry of dirs) {
    if (budget.remaining <= 0) return;
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (!(await stat(child)).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    const file = await resolveSkillFile(child);
    if (file) {
      const meta = await readSkillMeta(child, file, root);
      if (meta) {
        out.push(meta);
        budget.remaining -= 1;
      }
      continue;
    }
    await scanDirectory(child, root, depth + 1, budget, out);
  }
}

export async function discoverSkills(
  roots: readonly SkillRoot[],
): Promise<{ skills: SkillMeta[]; truncated: boolean }> {
  const found: SkillMeta[] = [];
  let truncated = false;
  for (const root of roots) {
    if (found.length >= MAX_TOTAL_SKILLS) {
      truncated = true;
      break;
    }
    const budget = {
      remaining: Math.min(MAX_SKILLS_PER_ROOT, MAX_TOTAL_SKILLS - found.length),
    };
    const before = found.length;
    await scanDirectory(root.path, root, 1, budget, found);
    if (found.length - before >= MAX_SKILLS_PER_ROOT) truncated = true;
  }
  return { skills: found, truncated };
}

const SCOPE_RANK: Record<SkillMeta["scope"], number> = {
  extra: 0,
  project: 1,
  user: 2,
};

export function dedupeSkills(skills: readonly SkillMeta[]): SkillMeta[] {
  const byName = new Map<string, { winner: SkillMeta; shadowed: string[] }>();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (!existing) {
      byName.set(skill.name, { winner: skill, shadowed: [] });
      continue;
    }
    if (SCOPE_RANK[skill.scope] < SCOPE_RANK[existing.winner.scope]) {
      existing.shadowed.push(existing.winner.file);
      existing.winner = skill;
    } else {
      existing.shadowed.push(skill.file);
    }
  }
  return [...byName.values()]
    .map(({ winner, shadowed }) =>
      shadowed.length > 0 ? { ...winner, shadowed } : winner,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
