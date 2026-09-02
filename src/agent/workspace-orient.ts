
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { safeCwd } from "../os/cwd.js";

export const PROJECT_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
  "index.html",
  "setup.py",
  "manage.py",
  "Cargo.lock",
  ".git",
] as const;

const BARE_PARENT_DIR_RE =
  /(?:^|[/\\])(?:Desktop|Documents|Downloads|Projects|dev|code|work|repos?|tmp|temp)$/i;

export function isBareParentDirectory(path: string): boolean {
  const p = resolve(path.trim()).replace(/[/\\]+$/, "");
  if (/^\/(?:Users|home)\/[^/\\]+$/i.test(p)) return true;
  if (p === homedir() || p === resolve(homedir())) return true;
  return BARE_PARENT_DIR_RE.test(p);
}

export function detectProjectMarkers(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of PROJECT_MARKERS) {
    try {
      if (existsSync(join(dir, name))) found.push(name);
    } catch {
    }
  }
  return found;
}

export function detectPackageManager(
  dir: string,
): "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "cargo" | "go" | undefined {
  if (!dir || !existsSync(dir)) return undefined;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(dir, "bun.lockb")) ||
    existsSync(join(dir, "bun.lock"))
  ) {
    return "bun";
  }
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  if (existsSync(join(dir, "package.json"))) return "npm";
  if (existsSync(join(dir, "poetry.lock")) || existsSync(join(dir, "pyproject.toml"))) {
    if (existsSync(join(dir, "poetry.lock"))) return "poetry";
  }
  if (existsSync(join(dir, "requirements.txt"))) return "pip";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo";
  if (existsSync(join(dir, "go.mod"))) return "go";
  return undefined;
}

export function isExistingProjectDir(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return detectProjectMarkers(dir).length > 0;
}

const IGNORED_PROJECT_CHILDREN = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
]);

export function discoverImmediateProjectRoots(
  parent: string,
  maxEntries = 80,
): string[] {
  const root = resolve(parent);
  if (!existsSync(root)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = entries
    .filter((entry) => {
      const name = entry.name;
      return Boolean(
        name &&
          !name.startsWith(".") &&
          name !== ".DS_Store" &&
          name !== "Thumbs.db" &&
          !IGNORED_PROJECT_CHILDREN.has(name) &&
          entry.isDirectory(),
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const projects: string[] = [];
  for (const entry of candidates) {
    const candidate = join(root, entry.name);
    if (isExistingProjectDir(candidate)) projects.push(candidate);
  }
  return projects.slice(0, Math.max(0, maxEntries));
}

export interface DirSnapshot {
  path: string;
  exists: boolean;
  isDir: boolean;
  entryCount: number;
  entries: string[];
  markers: string[];
  isProject: boolean;
  emptyOrMissing: boolean;
}

export function snapshotDir(path: string, maxNames = 36): DirSnapshot {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return {
      path: resolved,
      exists: false,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: true,
    };
  }
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    return {
      path: resolved,
      exists: true,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: false,
    };
  }
  if (!isDir) {
    return {
      path: resolved,
      exists: true,
      isDir: false,
      entryCount: 0,
      entries: [],
      markers: [],
      isProject: false,
      emptyOrMissing: false,
    };
  }
  let names: string[] = [];
  try {
    names = readdirSync(resolved);
  } catch {
    names = [];
  }
  const meaningful = names.filter((n) => n !== ".DS_Store" && n !== "Thumbs.db");
  const markers = detectProjectMarkers(resolved);
  return {
    path: resolved,
    exists: true,
    isDir: true,
    entryCount: names.length,
    entries: names.slice(0, maxNames),
    markers,
    isProject: markers.length > 0,
    emptyOrMissing: meaningful.length === 0,
  };
}

function formatSnapshot(label: string, snap: DirSnapshot): string {
  if (!snap.exists) {
    return `- ${label}: ${snap.path}\n  status: DOES NOT EXIST (safe to create as new project path)`;
  }
  if (!snap.isDir) {
    return `- ${label}: ${snap.path}\n  status: exists but is a FILE, not a directory`;
  }
  const markerLine =
    snap.markers.length > 0
      ? `project markers: ${snap.markers.join(", ")}`
      : "project markers: (none detected)";
  const entries =
    snap.entries.length > 0
      ? snap.entries.join(", ") +
        (snap.entryCount > snap.entries.length
          ? `, … (+${snap.entryCount - snap.entries.length} more)`
          : "")
      : "(empty)";
  const kind = snap.isProject
    ? "EXISTING PROJECT — do NOT re-scaffold into this directory; continue / implement inside it"
    : snap.emptyOrMissing
      ? "empty or only junk files — OK for a new scaffold into a subfolder here"
      : "non-empty directory (not a clear project root) — list carefully; scaffolders often refuse non-empty targets";
  const pm = detectPackageManager(snap.path);
  const pmLine = pm
    ? `package manager (from lockfile/manifest): ${pm} — use this for install/run, do not invent another`
    : undefined;
  return (
    `- ${label}: ${snap.path}\n` +
    `  status: ${kind}\n` +
    `  entries (${snap.entryCount}): ${entries}\n` +
    `  ${markerLine}` +
    (pmLine ? `\n  ${pmLine}` : "")
  );
}

export interface WorkspaceOrientationInput {
  cwd?: string;
  destinationHint?: string;
  candidateProject?: string;
  extraPaths?: string[];
}

export function guessProjectFolderName(text: string): string | undefined {
  const blob = text.trim();
  if (!blob) return undefined;

  const pathish = blob.match(
    /(?:Desktop|Documents|Projects|dev|code|work)[/\\]([A-Za-z0-9._-]+)/i,
  );
  if (pathish?.[1] && !/^(directory|folder|dir)$/i.test(pathish[1])) {
    return pathish[1];
  }

  const named = blob.match(
    /\b(?:project|app|service|cli|package|crate|module)\s+(?:called|named)\s+["']?([A-Za-z][A-Za-z0-9._-]{1,40})/i,
  );
  if (named?.[1]) return named[1];

  const createName = blob.match(
    /\b(?:create|scaffold|init|bootstrap)\s+(?:a\s+|an\s+)?(?:new\s+)?([A-Za-z][A-Za-z0-9._-]{1,40})(?:\s+(?:app|project|service))?\s+(?:in|on|under|into)\b/i,
  );
  if (
    createName?.[1] &&
    !/^(a|an|the|new|simple|react|vue|next|python|rust|go|node|web|todo)$/i.test(
      createName[1],
    )
  ) {
    return createName[1];
  }

  const kindApp = blob.match(
    /\b([a-z][a-z0-9]{1,20})[\s-]+(?:app|application|project|service|cli)\b/i,
  );
  if (
    kindApp?.[1] &&
    !/^(react|vue|next|simple|new|web|full|small|demo|sample|node|python|rust)$/i.test(
      kindApp[1],
    )
  ) {
    return `${kindApp[1].toLowerCase()}-app`;
  }

  return undefined;
}

export function buildWorkspaceOrientation(
  input: WorkspaceOrientationInput,
): string {
  const cwd = resolve(input.cwd?.trim() || safeCwd());
  const paths = new Map<string, string>();

  paths.set(cwd, "agent process cwd (NOT necessarily the user project)");

  if (input.destinationHint?.trim()) {
    const d = resolve(input.destinationHint.trim());
    if (!paths.has(d)) paths.set(d, "user destination (from prompt)");
  }

  if (input.candidateProject?.trim()) {
    const c = resolve(input.candidateProject.trim());
    if (!paths.has(c)) paths.set(c, "candidate project path (from plan/prompt)");
  }

  for (const extra of input.extraPaths ?? []) {
    if (!extra?.trim()) continue;
    const p = resolve(extra.trim());
    if (!paths.has(p)) paths.set(p, "related path");
  }

  const dest = input.destinationHint?.trim()
    ? resolve(input.destinationHint.trim())
    : undefined;
  const discoveryParent =
    dest ?? (isBareParentDirectory(cwd) ? cwd : undefined);
  if (discoveryParent) {
    for (const project of discoverImmediateProjectRoots(discoveryParent)) {
      if (!paths.has(project)) {
        paths.set(project, "discovered existing project under destination");
      }
    }
    for (const guess of ["todo-app", "app", "my-app", "project"]) {
      const p = join(discoveryParent, guess);
      if (!paths.has(p) && existsSync(p)) {
        paths.set(p, `existing subfolder under destination ("${guess}")`);
      }
    }
  }

  const lines = [
    "WORKSPACE STATUS (runtime pre-check — treat as EXPLORE step 1; still fs.list deeper as needed):",
    "Rules derived from this snapshot:",
    "1. Process cwd may be the agent package tree — never write user app source there unless the user asked to modify this agent.",
    "2. If a target project path ALREADY EXISTS with project markers, CONTINUE that project (edit feature files). Do NOT re-run a scaffolder into it (scaffolders cancel on non-empty dirs).",
    "3. If creating new, scaffold into a NEW empty subfolder under the destination (not into a non-empty dir).",
    "4. Prefer absolute paths under the real project root for all fs/shell work.",
    "5. If you choose plan.create, its detail must distinguish what already exists from what you will create.",
    "",
  ];

  for (const [path, label] of paths) {
    lines.push(formatSnapshot(label, snapshotDir(path)));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function extractScaffoldTargetName(command: string): string | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;

  const absCreate = cmd.match(
    /(?:npm\s+create\s+\S+|npx\s+(?:--yes\s+)?create-[\w@./-]+|yarn\s+create\s+\S+|pnpm\s+create\s+\S+|bun\s+create\s+\S+|npm\s+init\s+\S+|create-[\w@./-]+|vite@\S+|cargo\s+new|rails\s+new|poetry\s+new|flutter\s+create|django-admin\s+startproject|composer\s+create-project\s+\S+|mix\s+new|dotnet\s+new\s+\S+\s+(?:-n|--name))\s+((?:\/(?:Users|home)\/\S+|~\/\S+))/i,
  );
  if (absCreate?.[1] && !absCreate[1].includes("node_modules")) {
    const base = absCreate[1].replace(/\/+$/, "").split(/[/\\]/).pop();
    if (base && !base.startsWith("-")) return base;
  }

  const patterns: RegExp[] = [
    /(?:npm\s+create\s+\S+|npx\s+(?:--yes\s+)?create-[\w@./-]+|yarn\s+create\s+\S+|pnpm\s+create\s+\S+|bun\s+create\s+\S+)\s+([A-Za-z0-9._@/-]+)/i,
    /(?:npm\s+init\s+\S+)\s+([A-Za-z0-9._-]+)/i,
    /\bcargo\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bgo\s+mod\s+init\s+(\S+)/i,
    /\bpoetry\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bdjango-admin\s+startproject\s+([A-Za-z0-9._-]+)/i,
    /\brails\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bcomposer\s+create-project\s+\S+\s+([A-Za-z0-9._-]+)/i,
    /\bmix\s+new\s+([A-Za-z0-9._-]+)/i,
    /\bflutter\s+create\s+([A-Za-z0-9._-]+)/i,
    /\bcargo\s+init\b/i,
    /\bdotnet\s+new\s+\S+\s+-n\s+([A-Za-z0-9._-]+)/i,
    /\bdotnet\s+new\s+\S+\s+--name\s+([A-Za-z0-9._-]+)/i,
  ];

  for (const re of patterns) {
    const m = cmd.match(re);
    if (m?.[1] && m[1] !== "." && m[1] !== ".." && !m[1].startsWith("-")) {
      if (/^@/.test(m[1]) && !m[1].includes("/")) continue;
      const name = m[1].replace(/\/+$/, "").split(/[/\\]/).pop()!;
      if (name && name !== "." && !name.startsWith("-")) return name;
    }
  }

  const beforeFlags = cmd
    .replace(/\s+--\s+.*$/, "")
    .replace(/\s+--\S+=\S+/g, "")
    .replace(/\s+--\S+/g, "")
    .trim();
  const tokens = beforeFlags.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (
    last &&
    /^[A-Za-z0-9._-]+$/.test(last) &&
    !/^(latest|react|vue|svelte|vanilla|typescript|ts|js|app|yes)$/i.test(last) &&
    tokens.some((t) => /create|new|init|startproject/i.test(t))
  ) {
    return last;
  }

  return undefined;
}

export function resolveScaffoldTargetPath(
  command: string,
  shellCwd?: string,
): string | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;

  let base = resolve(shellCwd?.trim() || safeCwd());
  const stripShellQuotes = (raw: string): string =>
    raw.trim().replace(/^['"]|['"]$/g, "");
  const cdMatch = cmd.match(
    /(?:^|[;&|]\s*)cd\s+([^\s;&|]+)\s*(?:&&|;)/i,
  );
  if (cdMatch?.[1]) {
    const cdTarget = stripShellQuotes(cdMatch[1]).replace(/^~(?=\/)/, homedir());
    base = isAbsolute(cdTarget) ? resolve(cdTarget) : resolve(base, cdTarget);
  }
  const mkdirMatch = cmd.match(
    /mkdir\s+(?:-p\s+)?([^\s;&|]+)\s*(?:&&|;)/i,
  );
  if (mkdirMatch?.[1] && !cdMatch) {
    const m = stripShellQuotes(mkdirMatch[1]).replace(/^~(?=\/)/, homedir());
    if (isAbsolute(m) || m.startsWith("~/")) {
      base = resolve(m);
    }
  }

  if (
    /\bgo\s+mod\s+init\b/i.test(cmd) ||
    /\bcargo\s+init\b/i.test(cmd) ||
    /\bnpm\s+init\s+-y\b/i.test(cmd) ||
    /\bnpm\s+init\s+--yes\b/i.test(cmd)
  ) {
    return base;
  }

  const createAbs = cmd.match(
    /(?:create-[\w@./-]+|vite@\S+|cargo\s+new|rails\s+new|poetry\s+new)\s+(\/(?:Users|home)\/[^\s]+|~\/[^\s]+)/i,
  );
  if (createAbs?.[1]) {
    return resolve(createAbs[1].replace(/^~(?=\/)/, homedir()));
  }

  if (
    /(?:create-\S+|vite@\S+|init\s+\S+)\s+\.(?:\s|$)/i.test(cmd) ||
    /\s\.(?:\s+--|\s*$)/.test(cmd)
  ) {
    return base;
  }

  const name = extractScaffoldTargetName(cmd);
  if (!name) return undefined;
  if (name.includes("/") || name.includes("@")) {
    return base;
  }
  if (isAbsolute(name) || name.startsWith("~/")) {
    return resolve(name.replace(/^~(?=\/)/, homedir()));
  }
  if (base.endsWith(name) || base.endsWith("/" + name) || base.endsWith("\\" + name)) {
    return base;
  }
  return resolve(base, name);
}

export function isScaffoldCancelledOutput(output: string): boolean {
  const o = output.toLowerCase();
  return (
    /\boperation cancelled\b/.test(o) ||
    /\bcanceled\b/.test(o) ||
    /\buser aborted\b/.test(o) ||
    /\balready exists\b/.test(o) ||
    /\bdirectory is not empty\b/.test(o) ||
    /\bnon-empty\b/.test(o) ||
    /\brefusing to\b/.test(o) ||
    /\bcould not create\b/.test(o)
  );
}

export function scaffoldLooksMaterialized(targetPath: string | undefined): boolean {
  if (!targetPath || !existsSync(targetPath)) return false;
  const snap = snapshotDir(targetPath);
  if (!snap.isDir) return false;
  if (snap.isProject) return true;
  if (snap.entryCount >= 3 && !snap.emptyOrMissing) return true;
  return false;
}

export function scaffoldTargetConflictMessage(
  command: string,
  shellCwd?: string,
): string | undefined {
  const target = resolveScaffoldTargetPath(command, shellCwd);
  if (!target) return undefined;
  const snap = snapshotDir(target);
  if (!snap.exists || snap.emptyOrMissing) return undefined;
  if (snap.isProject || snap.entryCount > 0) {
    return (
      `Scaffold blocked: target already exists at ${target} ` +
      `(${snap.entryCount} entries` +
      (snap.markers.length ? `; markers: ${snap.markers.join(", ")}` : "") +
      `). Scaffolders refuse non-empty directories and print "Operation cancelled". ` +
      `Choose one: (A) CONTINUE the existing project — set work there with absolute paths, implement the requested feature, do NOT re-scaffold; ` +
      `(B) use a NEW empty subfolder name; or (C) only if the user asked to recreate from scratch, remove the directory first then scaffold. ` +
      `fs.list the target before deciding.`
    );
  }
  return undefined;
}
