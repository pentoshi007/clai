/**
 * Per-session scratch + tool-output workspace.
 *
 * Each chat/history session owns a unique folder under the OS temp root:
 *
 *   {tmpdir}/clai/{code}-{DD}-{MM}-{YYYY}-{HH}-{MM}-{SS}/
 *     temp/          ← tool run outputs (fs.list, shell.exec, recon, …)
 *     …              ← agent scratch (findings.md, engagement notes, …)
 *
 * `code` is a 6-digit hexadecimal id. The timestamp is local wall-clock
 * of session creation so operators can spot folders by eye. Folder names
 * use only [0-9a-f-] so they are safe on Windows, macOS, and Linux.
 *
 * The active workspace is process-global (one live TUI/REPL session).
 * History records store `workspaceFolder` + `workspaceCode` so resume
 * rebinds the same directory when it still exists (or recreates it).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface SessionWorkspace {
  /** 6-char lowercase hex code (session workspace id). */
  readonly code: string;
  /** Folder name only, e.g. `a3f9c1-18-07-2026-14-24-23`. */
  readonly folderName: string;
  /** Absolute path to the session workspace root (scratch). */
  readonly rootDir: string;
  /** Absolute path to `{root}/temp` (tool output artifacts). */
  readonly tempDir: string;
}

/** Regex for the 6-hex workspace code. */
export const SESSION_CODE_RE = /^[0-9a-f]{6}$/;

/** Regex for a full session folder name (code + local timestamp). */
export const SESSION_FOLDER_RE =
  /^[0-9a-f]{6}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}$/;

let active: SessionWorkspace | undefined;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Generate a cryptographically random 6-digit hexadecimal code. */
export function generateSessionCode(): string {
  return randomBytes(3).toString("hex");
}

export function isValidSessionCode(code: string): boolean {
  return SESSION_CODE_RE.test(code.toLowerCase());
}

export function isValidSessionFolderName(name: string): boolean {
  return SESSION_FOLDER_RE.test(name.toLowerCase());
}

/**
 * Build `{code}-{DD}-{MM}-{YYYY}-{HH}-{MM}-{SS}` using local time.
 * Example: `a3f9c1-25-08-2003-22-45-56`.
 */
export function formatSessionFolderName(
  code: string,
  at: Date = new Date(),
): string {
  const normalized = code.toLowerCase();
  if (!isValidSessionCode(normalized)) {
    throw new Error(`invalid session code: ${code}`);
  }
  return [
    normalized,
    pad2(at.getDate()),
    pad2(at.getMonth() + 1),
    String(at.getFullYear()),
    pad2(at.getHours()),
    pad2(at.getMinutes()),
    pad2(at.getSeconds()),
  ].join("-");
}

/** Parent of all session workspaces: `{tmpdir}/clai`. */
export function getSessionWorkspaceParent(): string {
  return join(tmpdir(), "clai");
}

export function sessionWorkspaceRoot(folderName: string): string {
  // Reject path separators / traversal so a corrupted history record cannot
  // escape the clai temp namespace. Do not silently strip separators — that
  // would turn "a/b" into "ab" and hide the attack.
  const safe = folderName.trim();
  if (
    !safe ||
    safe === "." ||
    safe === ".." ||
    safe.includes("..") ||
    /[/\\]/.test(safe) ||
    safe.includes("\0")
  ) {
    throw new Error(`invalid session folder name: ${folderName}`);
  }
  return join(getSessionWorkspaceParent(), safe);
}

export function sessionTempDir(folderName: string): string {
  return join(sessionWorkspaceRoot(folderName), "temp");
}

function toWorkspace(code: string, folderName: string): SessionWorkspace {
  const rootDir = sessionWorkspaceRoot(folderName);
  return {
    code: code.toLowerCase(),
    folderName,
    rootDir,
    tempDir: join(rootDir, "temp"),
  };
}

/** Create root + temp directories (idempotent, cross-platform). */
export function ensureSessionWorkspaceDirs(ws: SessionWorkspace): void {
  try {
    mkdirSync(ws.rootDir, { recursive: true });
    mkdirSync(ws.tempDir, { recursive: true });
  } catch {
    // Best-effort: callers tolerate missing dirs (artifact open already
    // retries mkdir). Never throw out of path setup.
  }
}

/**
 * Mint a new unique session workspace. Retries the 6-hex code if the
 * folder name already exists for the same second (astronomically rare).
 */
export function mintSessionWorkspace(at: Date = new Date()): SessionWorkspace {
  for (let attempt = 0; attempt < 16; attempt++) {
    const code = generateSessionCode();
    const folderName = formatSessionFolderName(code, at);
    const root = sessionWorkspaceRoot(folderName);
    if (!existsSync(root)) {
      const ws = toWorkspace(code, folderName);
      ensureSessionWorkspaceDirs(ws);
      return ws;
    }
  }
  // Last resort: still unique by appending 2 more hex digits (folder name
  // diverges slightly from the strict template only under pathological
  // collision — keeps the process from looping forever).
  const code = generateSessionCode();
  const folderName = `${formatSessionFolderName(code, at)}-${randomBytes(1).toString("hex")}`;
  const ws = toWorkspace(code, folderName);
  ensureSessionWorkspaceDirs(ws);
  return ws;
}

/**
 * Restore a previously persisted workspace. Recreates dirs if the OS
 * cleaned temp; accepts a folder name even when the code field is missing
 * (older partial records) by parsing the leading 6 hex digits.
 */
export function restoreSessionWorkspace(
  folderName: string,
  code?: string | undefined,
): SessionWorkspace {
  const safeName = folderName.trim();
  // Prefer strict validation; fall back to minting if the stored name is
  // corrupted (should never happen for records we wrote ourselves).
  if (
    !safeName ||
    /[/\\]/.test(safeName) ||
    safeName.includes("..") ||
    safeName.includes("\0")
  ) {
    return mintSessionWorkspace();
  }
  if (!isValidSessionFolderName(safeName) && !/^[0-9a-f]{6}-/i.test(safeName)) {
    return mintSessionWorkspace();
  }
  const resolvedCode =
    (code && isValidSessionCode(code) ? code.toLowerCase() : undefined) ??
    safeName.slice(0, 6).toLowerCase();
  if (!isValidSessionCode(resolvedCode)) {
    return mintSessionWorkspace();
  }
  try {
    const ws = toWorkspace(resolvedCode, safeName);
    ensureSessionWorkspaceDirs(ws);
    return ws;
  } catch {
    return mintSessionWorkspace();
  }
}

export function getActiveSessionWorkspace(): SessionWorkspace | undefined {
  return active;
}

export function bindSessionWorkspace(ws: SessionWorkspace): SessionWorkspace {
  ensureSessionWorkspaceDirs(ws);
  active = ws;
  return ws;
}

/**
 * Start (or rebind) the active session workspace.
 * - With a prior folder name → restore/recreate that session's dirs.
 * - Without → mint a fresh unique workspace.
 */
export function beginSessionWorkspace(existing?: {
  folderName?: string | undefined;
  code?: string | undefined;
}): SessionWorkspace {
  if (existing?.folderName && existing.folderName.trim()) {
    return bindSessionWorkspace(
      restoreSessionWorkspace(existing.folderName, existing.code),
    );
  }
  return bindSessionWorkspace(mintSessionWorkspace());
}

/** Drop the active binding (tests / process teardown). Does not delete files. */
export function clearActiveSessionWorkspace(): void {
  active = undefined;
}

export function removeSessionWorkspaceFolder(folderName: string): boolean {
  if (active?.folderName === folderName) return false;
  let root: string;
  try {
    root = sessionWorkspaceRoot(folderName);
  } catch {
    return false;
  }
  if (!isUnderSessionWorkspaceParent(root)) return false;
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Absolute scratch root for the active session, if any. */
export function getActiveSessionScratchDir(): string | undefined {
  return active?.rootDir;
}

/** Absolute tool-output dir for the active session, if any. */
export function getActiveSessionTempDir(): string | undefined {
  return active?.tempDir;
}

/**
 * True when `path` lives under the session workspace parent (`…/clai/`).
 * Used by cleanup and safety checks.
 */
export function isUnderSessionWorkspaceParent(path: string): boolean {
  const parent = resolve(getSessionWorkspaceParent());
  const target = resolve(path);
  const rel = target.slice(parent.length);
  return (
    target === parent ||
    (target.startsWith(parent + sep) && !rel.includes(`..${sep}`))
  );
}
