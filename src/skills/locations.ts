import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { getDataDir } from "../store/paths.js";
import type { SkillRoot, SkillScope } from "./types.js";

const PROJECT_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  [".clai/skills", "clai"],
  [".claude/skills", "claude"],
  [".agents/skills", "agents"],
  [".agent/skills", "agent"],
  ["agents/skills", "agents"],
  [".github/skills", "copilot"],
  [".opencode/skills", "opencode"],
  [".opencode/skill", "opencode"],
  [".codex/skills", "codex"],
  [".antigravity/skills", "antigravity"],
  [".gemini/skills", "gemini"],
  [".cursor/skills", "cursor"],
  [".windsurf/skills", "windsurf"],
  ["skills", "workspace"],
];

const PROJECT_MARKER_FILES: readonly string[] = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "requirements.txt",
  "CMakeLists.txt",
  "AGENTS.md",
  ".clai",
];

const MAX_ANCESTOR_LEVELS = 4;

function xdgConfigHome(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  if (configured) return resolve(configured);
  return join(homedir(), ".config");
}

function userRootSpecs(): ReadonlyArray<readonly [string, string]> {
  const home = homedir();
  const xdg = xdgConfigHome();
  const appData = process.env.APPDATA?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const specs: Array<readonly [string, string]> = [
    [join(getDataDir(), "skills"), "clai"],
    [join(home, ".clai", "skills"), "clai"],
    [join(home, ".claude", "skills"), "claude"],
    [join(home, ".codex", "skills"), "codex"],
    [join(home, ".agents", "skills"), "agents"],
    [join(home, ".agent", "skills"), "agent"],
    [join(home, ".antigravity", "skills"), "antigravity"],
    [join(home, ".gemini", "antigravity", "skills"), "antigravity"],
    [join(home, ".gemini", "skills"), "gemini"],
    [join(home, ".cursor", "skills"), "cursor"],
    [join(home, ".opencode", "skills"), "opencode"],
    [join(home, ".opencode", "skill"), "opencode"],
    [join(xdg, "opencode", "skills"), "opencode"],
    [join(xdg, "opencode", "skill"), "opencode"],
    [join(xdg, "claude", "skills"), "claude"],
    [join(xdg, "codex", "skills"), "codex"],
    [join(xdg, "agents", "skills"), "agents"],
    [join(xdg, "clai", "skills"), "clai"],
  ];
  if (appData) {
    specs.push(
      [join(appData, "opencode", "skills"), "opencode"],
      [join(appData, "Claude", "skills"), "claude"],
      [join(appData, "codex", "skills"), "codex"],
      [join(appData, "clai", "skills"), "clai"],
    );
  }
  if (localAppData) {
    specs.push(
      [join(localAppData, "antigravity", "skills"), "antigravity"],
      [join(localAppData, "opencode", "skills"), "opencode"],
    );
  }
  return specs;
}

function extraRootSpecs(): ReadonlyArray<readonly [string, string]> {
  const configured = process.env.CLAI_SKILLS_PATH?.trim();
  if (!configured) return [];
  return configured
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => [resolve(part), "custom"] as const);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKER_FILES.some((marker) => existsSync(join(dir, marker)));
}

function isBoundary(dir: string): boolean {
  const home = resolve(homedir());
  const current = resolve(dir);
  return current === home || dirname(current) === current;
}

export function projectSearchDirs(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): string[] {
  const seeds = [input.projectRoot, input.cwd]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => resolve(value));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  for (const seed of seeds) {
    push(seed);
    let current = seed;
    for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
      if (isBoundary(current)) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      if (isBoundary(current)) break;
      push(current);
      if (hasProjectMarker(current)) break;
    }
  }
  return out;
}

export function skillSearchRoots(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): SkillRoot[] {
  const collected: SkillRoot[] = [];
  const seen = new Set<string>();
  const add = (path: string, tool: string, scope: SkillScope): void => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    if (!isDirectory(path)) return;
    collected.push({ path, tool, scope });
  };

  for (const [path, tool] of extraRootSpecs()) add(path, tool, "extra");
  for (const dir of projectSearchDirs(input)) {
    for (const [suffix, tool] of PROJECT_SUFFIXES) {
      add(join(dir, ...suffix.split("/")), tool, "project");
    }
  }
  for (const [path, tool] of userRootSpecs()) add(path, tool, "user");
  return collected;
}

export function skillSearchLocationHints(): string[] {
  return [
    ".clai/skills",
    ".claude/skills",
    ".agents/skills",
    ".github/skills",
    ".opencode/skills",
    ".codex/skills",
    ".antigravity/skills",
    ".cursor/skills",
    "~/.clai/skills",
    "~/.claude/skills",
    "~/.codex/skills",
    "~/.config/opencode/skills",
    "$CLAI_SKILLS_PATH",
  ];
}
