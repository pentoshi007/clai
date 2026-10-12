import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "./detection.js";
import type { InstallMethod } from "./installers.js";

function owner(file: string): { pid: number; token?: string } | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || !("pid" in data) || typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid < 1) {
    throw new Error(`invalid update lock; inspect ${file} before retrying`);
  }
  const token = "token" in data && typeof data.token === "string" ? data.token : undefined;
  return { pid: data.pid, ...(token ? { token } : {}) };
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

function recover(file: string): void {
  const guard = `${file}.recovery`;
  try { mkdirSync(guard, { mode: 0o700 }); }
  catch { throw new Error(`update lock recovery is busy; retry or inspect ${guard} if the previous updater exited`); }
  try {
    const pid = owner(file);
    if (pid !== undefined && running(pid.pid)) throw new Error("an update is already in progress for this installation; close other update sessions before retrying");
    rmSync(file, { force: true });
  } finally { rmSync(guard, { recursive: true, force: true }); }
}

export function acquireUpdateLock(method: InstallMethod): { readonly file: string; readonly token: string; release: () => void } {
  let path = method.prefix ?? method.packageRoot ?? method.executablePath ?? process.execPath;
  if (method.type === "pnpm" && method.scope === "global") {
    const index = path.replace(/\\/g, "/").indexOf("/global/");
    if (index >= 0) path = path.slice(0, index);
  }
  const identity = canonicalPath(path);
  const hash = createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex").slice(0, 24);
  const file = join(tmpdir(), `clai-update-${hash}.lock`);
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(descriptor); }
      return { file, token, release: () => {
        if (owner(file)?.token === token) rmSync(file, { force: true });
      } };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const pid = owner(file);
      if (pid !== undefined && running(pid.pid)) throw new Error("an update is already in progress for this installation; close other update sessions before retrying");
      recover(file);
    }
  }
  throw new Error("could not acquire the installation update lock");
}
