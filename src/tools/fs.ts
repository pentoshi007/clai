import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  open,
  readFile,
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

let atomicWriteCounter = 0;
const fileMutationLanes = new Map<string, Promise<void>>();
const RETRYABLE_FS_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);

function mutationKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function mutationTarget(path: string): string {
  return canonicalizeForContainment(path) ?? path;
}

export async function withFileMutation<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = mutationKey(mutationTarget(path));
  const previous = fileMutationLanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileMutationLanes.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (fileMutationLanes.get(key) === current) fileMutationLanes.delete(key);
  }
}

function retryableFsError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return RETRYABLE_FS_CODES.has(code);
}

async function writeFileAtomicAttempt(
  path: string,
  contents: string,
): Promise<void> {
  const resolved = mutationTarget(path);
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
    if (priorMode !== undefined) await chmod(tempPath, priorMode);
    await rename(tempPath, resolved);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writeFileAtomic(
  resolved: string,
  contents: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFileAtomicAttempt(resolved, contents);
      return;
    } catch (error) {
      if (attempt >= 3 || !retryableFsError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** attempt));
    }
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

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

function isUnderRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
  );
}

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

export function isOutsideWorkingDirectory(resolvedPath: string): boolean {
  const target = canonicalizeForContainment(resolvedPath);
  if (!target) return true;
  const cwd = canonicalizeForContainment(safeCwd());
  if (cwd && isUnderRoot(cwd, target)) return false;
  const projectRoot = getActiveProjectRoot();
  const canonicalProject = projectRoot
    ? canonicalizeForContainment(projectRoot)
    : undefined;
  if (canonicalProject && isUnderRoot(canonicalProject, target)) return false;
  const canonicalTmp = canonicalizeForContainment(tmpdir());
  if (canonicalTmp && isUnderRoot(canonicalTmp, target)) return false;
  return true;
}

export function resolveFsToolPath(path: string): string {
  return resolvePath(path);
}

export interface FsReadOptions {
  maxBytes?: number | undefined;
  confirmed?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  pattern?: string | undefined;
  context?: number | undefined;
  maxMatches?: number | undefined;
  caseInsensitive?: boolean | undefined;
}

export async function fsWrite(
  path: string,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  return withFileMutation(resolved, async () => {
    let before = "";
    let existed = false;
    try {
      before = await readFile(resolved, "utf8");
      existed = true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(resolved), { recursive: true });
    await writeFileAtomic(resolved, content);
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
  });
}

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
  return withFileMutation(resolved, async () => {
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
  });
}

export interface FileWrite {
  path: string;
  content: string;
}
