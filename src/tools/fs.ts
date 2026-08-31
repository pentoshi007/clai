import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  open,
  readFile,
  writeFile,
  unlink,
  rename,
  mkdir,
  stat,
  chmod,
} from "node:fs/promises";
import { join, dirname, basename, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";
import { safeCwd } from "../os/cwd.js";
import { getActiveProjectRoot } from "../agent/project-root.js";
import { buildFileChange } from "./file-diff.js";
import { describeWrite } from "./fs/mutations.js";
import { ensureWriteAllowed } from "./fs/internals.js";
import { resolvePath } from "./fs/internals-2.js";
export { fsList, fsRead } from "./fs/read.js";
export { fsAppend, fsDelete, fsEdit, fsWriteMany } from "./fs/mutations.js";
export { fsSearch } from "./fs/search.js";

/**
 * Atomically replace a file's contents while preserving its permissions.
 *
 * - The temp name is unique per process/attempt, so two concurrent edits of the
 *   same target can never share a staging file and clobber each other.
 * - The original mode is re-applied to the replacement, so an executable script
 *   stays 0755 and a private key/config stays 0600 after an edit.
 * - Data is flushed (fsync) before the rename, and the temp file is removed on
 *   any failure so a crash cannot leave a stray `.clai-*` file behind.
 */
let atomicWriteCounter = 0;

export async function writeFileAtomic(
  resolved: string,
  contents: string,
): Promise<void> {
  const priorMode = await stat(resolved)
    .then((st) => st.mode & 0o7777)
    .catch(() => undefined);
  atomicWriteCounter += 1;
  const unique = `${process.pid}-${Date.now().toString(36)}-${atomicWriteCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const tempPath = join(
    dirname(resolved),
    `.${basename(resolved)}.clai-${unique}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", priorMode ?? 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (priorMode !== undefined) {
      await chmod(tempPath, priorMode);
    }
    await rename(tempPath, resolved);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Decide whether a path falls inside configured sandbox roots / cwd / home.
 * Used for UX (outside-cwd confirm) and optional sandboxReads opt-in.
 * Writes are not hard-blocked by sandbox — outside cwd always prompts instead.
 */
export function pathInsideSandbox(
  resolvedPath: string,
  mode: "read" | "write",
): boolean {
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    safeCwd(),
    tmpdir(),
  ];
  if (mode === "read") {
    roots.push(homedir());
  }
  return roots.some((root) => {
    const rel = relative(root, resolvedPath);
    return (
      rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
    );
  });
}

/** True when target is under root (or equal). */
function isUnderRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
  );
}

/**
 * Canonicalize an existing target or its nearest existing ancestor. This
 * resolves directory and leaf symlinks even when the final file does not yet
 * exist, so lexical `project/link/file` paths cannot escape a trusted root.
 * Returning undefined is conservative: callers must require confirmation.
 */
function canonicalizeForContainment(path: string): string | undefined {
  let cursor = resolve(path);
  let suffix: string[] = [];
  const visited = new Set<string>();

  while (true) {
    if (visited.has(cursor)) return undefined;
    visited.add(cursor);
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) {
        const linked = resolve(dirname(cursor), readlinkSync(cursor));
        cursor = resolve(linked, ...suffix);
        suffix = [];
        continue;
      }
      const canonical = realpathSync(cursor);
      return resolve(canonical, ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * True when a write sits outside the working directory and active project
 * root, but not system temp / scratch (agent scratch lives under tmpdir and
 * must not spam confirmations). Default permissions confirm such writes;
 * allow-all auto-approves them. Deletes are handled separately and always
 * confirm.
 */
export function isOutsideWorkingDirectory(resolvedPath: string): boolean {
  const target = canonicalizeForContainment(resolvedPath);
  if (!target) return true;
  const cwd = canonicalizeForContainment(safeCwd());
  if (cwd && isUnderRoot(cwd, target)) return false;
  const projectRoot = getActiveProjectRoot();
  const canonicalProject = projectRoot
    ? canonicalizeForContainment(projectRoot)
    : undefined;
  // A scaffolded/discovered project can intentionally live outside the CLAI
  // process cwd (for example ~/Desktop/bloging-app). Once that root is pinned,
  // writes inside it are part of the active user-approved workspace and should
  // honor allow-all instead of prompting for every file. Siblings and deletes
  // remain protected by the runner's normal confirmation rules.
  if (canonicalProject && isUnderRoot(canonicalProject, target)) return false;
  const canonicalTmp = canonicalizeForContainment(tmpdir());
  if (canonicalTmp && isUnderRoot(canonicalTmp, target)) return false;
  return true;
}

/** Resolve a tool path for permission checks (tilde + project root). */
export function resolveFsToolPath(path: string): string {
  return resolvePath(path);
}

export interface FsReadOptions {
  maxBytes?: number | undefined;
  confirmed?: boolean | undefined;
  /** 1-indexed first line to return (inclusive). */
  offset?: number | undefined;
  /** Max number of lines to return from `offset`. */
  limit?: number | undefined;
  /** Alias for `offset` (1-indexed inclusive). */
  startLine?: number | undefined;
  /** Inclusive end line; implies a line window when set. */
  endLine?: number | undefined;
  /** Regex source (no surrounding slashes). Return matching windows with context. */
  pattern?: string | undefined;
  /** Lines of context each side of a pattern match (default 2, max 20). */
  context?: number | undefined;
  /** Max pattern matches to return (default 20, hard max 100). */
  maxMatches?: number | undefined;
  /** Case-insensitive pattern match. */
  caseInsensitive?: boolean | undefined;
}

export async function fsWrite(
  path: string,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  // Create any missing parent directories so writing "src/index.js" into a
  // fresh project just works — the agent should not have to chain a separate
  // mkdir before every file write. This was the most common failure: ENOENT
  // on a path whose parent dir did not exist yet.
  let before = "";
  let existed = false;
  try {
    before = await readFile(resolved, "utf8");
    existed = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  const change = buildFileChange({
    path: resolved,
    before,
    after: content,
    kind: existed ? "overwrite" : "create",
  });
  const verb = existed ? "Wrote" : "Created";
  return {
    ok: true,
    output: describeWrite(resolved, content, verb),
    fileChanges: [change],
  };
}

/** Atomically replace an inclusive, 1-indexed line range in an existing file. */
export async function fsReplaceLines(
  path: string,
  startLine: number,
  endLine: number,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return {
      ok: false,
      output:
        "fs.replaceLines requires integers with 1 <= startLine <= endLine",
      exitCode: 1,
    };
  }
  const original = await readFile(resolved, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith("\n");
  const lines = original.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  if (endLine > lines.length) {
    return {
      ok: false,
      output: `fs.replaceLines range ${startLine}-${endLine} exceeds ${lines.length} lines`,
      exitCode: 1,
    };
  }
  const replacement = content === "" ? [] : content.split(/\r?\n/);
  if (replacement.at(-1) === "") replacement.pop();
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  const next = lines.join(newline) + (hadFinalNewline ? newline : "");
  await writeFileAtomic(resolved, next);
  // X10: receipt with line count + hash so the model notices size changes.
  const verb =
    content === ""
      ? `Deleted lines ${startLine}-${endLine} in`
      : `Replaced lines ${startLine}-${endLine} in`;
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "edit",
  });
  return {
    ok: true,
    output: describeWrite(resolved, next, verb),
    fileChanges: [change],
  };
}

export interface FileWrite {
  path: string;
  content: string;
}
