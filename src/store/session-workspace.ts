
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface SessionWorkspace {
  readonly code: string;
  readonly folderName: string;
  readonly rootDir: string;
  readonly tempDir: string;
}

export const SESSION_CODE_RE = /^[0-9a-f]{6}$/;

export const SESSION_FOLDER_RE =
  /^[0-9a-f]{6}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2}$/;

let active: SessionWorkspace | undefined;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function generateSessionCode(): string {
  return randomBytes(3).toString("hex");
}

export function isValidSessionCode(code: string): boolean {
  return SESSION_CODE_RE.test(code.toLowerCase());
}

export function isValidSessionFolderName(name: string): boolean {
  return SESSION_FOLDER_RE.test(name.toLowerCase());
}

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

export function getSessionWorkspaceParent(): string {
  const override = process.env.CLAI_SESSION_WORKSPACE_DIR?.trim();
  return override ? resolve(override) : join(tmpdir(), "clai");
}

export function sessionWorkspaceRoot(folderName: string): string {
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

export function ensureSessionWorkspaceDirs(ws: SessionWorkspace): void {
  try {
    mkdirSync(ws.rootDir, { recursive: true });
    mkdirSync(ws.tempDir, { recursive: true });
  } catch {
  }
}

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
  const code = generateSessionCode();
  const folderName = `${formatSessionFolderName(code, at)}-${randomBytes(1).toString("hex")}`;
  const ws = toWorkspace(code, folderName);
  ensureSessionWorkspaceDirs(ws);
  return ws;
}

export function restoreSessionWorkspace(
  folderName: string,
  code?: string | undefined,
): SessionWorkspace {
  const safeName = folderName.trim();
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

export function getActiveSessionScratchDir(): string | undefined {
  return active?.rootDir;
}

export function getActiveSessionTempDir(): string | undefined {
  return active?.tempDir;
}

export function isUnderSessionWorkspaceParent(path: string): boolean {
  const parent = resolve(getSessionWorkspaceParent());
  const target = resolve(path);
  const rel = target.slice(parent.length);
  return (
    target === parent ||
    (target.startsWith(parent + sep) && !rel.includes(`..${sep}`))
  );
}
