import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { dedupeSkills, discoverSkills, normalizeSkillName } from "./discover.js";
import { skillSearchRoots } from "./locations.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  EMPTY_SKILL_INDEX,
  type LoadedSkill,
  type SkillIndex,
  type SkillMeta,
} from "./types.js";

const INDEX_TTL_MS = 10_000;
const MAX_BODY_CHARS = 48 * 1024;
const MAX_RESOURCES = 40;
const RESOURCE_DEPTH = 2;

export interface SkillScanInput {
  readonly cwd?: string | undefined;
  readonly projectRoot?: string | undefined;
}

interface CacheEntry {
  readonly key: string;
  readonly index: SkillIndex;
}

let cache: CacheEntry | undefined;
let inflight: Promise<SkillIndex> | undefined;

function scanKey(input: SkillScanInput): string {
  return `${input.projectRoot ?? ""}\u0000${input.cwd ?? safeCwd()}`;
}

function buildIndex(
  skills: readonly SkillMeta[],
  roots: SkillIndex["roots"],
  truncated: boolean,
): SkillIndex {
  return {
    skills,
    roots,
    names: new Set(skills.map((skill) => skill.name)),
    scannedAt: Date.now(),
    truncated,
  };
}

async function scan(input: SkillScanInput): Promise<SkillIndex> {
  const cwd = input.cwd ?? safeCwd();
  const roots = skillSearchRoots({
    cwd,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
  });
  if (roots.length === 0) return buildIndex([], roots, false);
  const { skills, truncated } = await discoverSkills(roots);
  return buildIndex(dedupeSkills(skills), roots, truncated);
}

export async function getSkillIndex(
  input: SkillScanInput = {},
): Promise<SkillIndex> {
  const key = scanKey(input);
  const fresh =
    cache?.key === key && Date.now() - cache.index.scannedAt < INDEX_TTL_MS;
  if (fresh) return cache!.index;
  if (inflight) return inflight;
  inflight = scan(input)
    .then((index) => {
      cache = { key, index };
      return index;
    })
    .catch(() => {
      const fallback = buildIndex([], [], false);
      cache = { key, index: fallback };
      return fallback;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

export function skillIndexSnapshot(): SkillIndex {
  return cache?.index ?? EMPTY_SKILL_INDEX;
}

export function skillNamesSnapshot(): ReadonlySet<string> {
  return skillIndexSnapshot().names;
}

export function findSkillInSnapshot(name: string): SkillMeta | undefined {
  const normalized = normalizeSkillName(name);
  if (!normalized) return undefined;
  return skillIndexSnapshot().skills.find((skill) => skill.name === normalized);
}

export function invalidateSkillIndex(): void {
  cache = undefined;
}

async function listResources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > RESOURCE_DEPTH || out.length >= MAX_RESOURCES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_RESOURCES) return;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/^skill\.md$/i.test(entry.name)) continue;
      out.push(relative(dir, child).split(sep).join("/"));
    }
  };
  await walk(dir, 1);
  return out.sort();
}

export async function loadSkill(
  name: string,
  input: SkillScanInput = {},
): Promise<LoadedSkill | undefined> {
  const index = await getSkillIndex(input);
  const normalized = normalizeSkillName(name);
  const meta = normalized
    ? index.skills.find((skill) => skill.name === normalized)
    : undefined;
  if (!meta) return undefined;
  let raw: string;
  try {
    raw = await readFile(meta.file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(raw);
  const source = parsed.present ? parsed.body : raw.trim();
  const truncated = source.length > MAX_BODY_CHARS;
  const body = truncated ? source.slice(0, MAX_BODY_CHARS) : source;
  return {
    meta,
    body,
    resources: await listResources(meta.dir),
    truncated,
  };
}

export async function skillFileSignature(
  meta: SkillMeta,
): Promise<string | undefined> {
  try {
    const info = await stat(meta.file);
    return `${meta.file}:${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}
