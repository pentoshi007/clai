import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getDataDir } from "../store/paths.js";

export const PROJECT_DIR_NAME = ".clai";
export const CLAI_INSTRUCTIONS_FILE = "CLAI.md";
export const RECORDED_INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

export type InstructionScope = "user" | "ancestor" | "project" | "recorded";

export interface InstructionCandidate {
  readonly path: string;
  readonly scope: InstructionScope;
}

const USER_FILE_NAMES: readonly string[] = ["CLAI.md", "clai.md", "AGENTS.md", "agents.md"];
const DIR_FILE_NAMES: readonly string[] = [
  "AGENTS.md",
  "agents.md",
  "CLAI.md",
  "clai.md",
  join(PROJECT_DIR_NAME, "CLAI.md"),
  join(PROJECT_DIR_NAME, "clai.md"),
];
const MAX_ANCESTOR_LEVELS = 4;
const PROJECT_MARKERS: readonly string[] = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function isHomeDirectory(dir: string): boolean {
  const home = resolve(homedir());
  const target = resolve(dir);
  if (target === home) return true;
  const profile = process.env.USERPROFILE?.trim();
  if (profile && resolve(profile) === target) return true;
  const explicit = process.env.HOME?.trim();
  if (explicit && resolve(explicit) === target) return true;
  return false;
}

function isFilesystemRoot(dir: string): boolean {
  const target = resolve(dir);
  return dirname(target) === target;
}

function isGlobalDataDir(dir: string): boolean {
  return pathKey(resolve(dir)) === pathKey(resolve(getDataDir()));
}

export function instructionSearchDirs(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): string[] {
  const seeds = [input.projectRoot, input.cwd]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => resolve(value))
    .filter((value) => !isHomeDirectory(value) && !isFilesystemRoot(value));
  const chains: string[][] = [];
  for (const seed of seeds) {
    const chain = [seed];
    let current = seed;
    for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
      const parent = dirname(current);
      if (parent === current) break;
      if (isHomeDirectory(parent) || isFilesystemRoot(parent)) break;
      current = parent;
      chain.push(current);
      if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker)))) break;
    }
    chains.push(chain.reverse());
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    for (const dir of chain) {
      const key = pathKey(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out;
}

function canonicalKey(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return pathKey(path);
  }
}

export function instructionCandidates(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): InstructionCandidate[] {
  const out: InstructionCandidate[] = [];
  const visited = new Set<string>();
  const canonical = new Set<string>();
  const add = (path: string, scope: InstructionScope): void => {
    const key = pathKey(path);
    if (visited.has(key)) return;
    visited.add(key);
    if (!isFile(path)) return;
    const real = canonicalKey(path);
    if (canonical.has(real)) return;
    canonical.add(real);
    out.push({ path, scope });
  };

  const dataDir = getDataDir();
  for (const name of USER_FILE_NAMES) add(join(dataDir, name), "user");
  const home = homedir();
  if (pathKey(resolve(dataDir)) !== pathKey(resolve(join(home, ".clai")))) {
    for (const name of USER_FILE_NAMES) add(join(home, ".clai", name), "user");
  }

  const dirs = instructionSearchDirs(input);
  const innermost = dirs[dirs.length - 1];
  for (const dir of dirs) {
    const scope: InstructionScope = dir === innermost ? "project" : "ancestor";
    for (const name of DIR_FILE_NAMES) add(join(dir, name), scope);
  }
  if (innermost) {
    add(join(innermost, PROJECT_DIR_NAME, RECORDED_INSTRUCTIONS_FILE), "recorded");
    add(join(innermost, PROJECT_DIR_NAME, "instructions.md"), "recorded");
  }
  return out;
}

export function scaffoldTargetDir(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): string | undefined {
  const candidate = resolve(
    input.projectRoot?.trim() ? input.projectRoot : input.cwd,
  );
  if (!isDir(candidate)) return undefined;
  if (isHomeDirectory(candidate)) return undefined;
  if (isFilesystemRoot(candidate)) return undefined;
  if (isGlobalDataDir(candidate)) return undefined;
  return candidate;
}

export function recordedInstructionsPath(root: string): string {
  return join(root, PROJECT_DIR_NAME, RECORDED_INSTRUCTIONS_FILE);
}

export function claiInstructionsPath(root: string): string {
  return join(root, PROJECT_DIR_NAME, CLAI_INSTRUCTIONS_FILE);
}
