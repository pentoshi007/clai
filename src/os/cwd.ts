import { homedir } from "node:os";
import { existsSync } from "node:fs";

/**
 * A process.cwd() that never throws.
 *
 * When the current working directory is deleted out from under a running
 * process (e.g. the user `rm -rf`s the folder clai was launched in, or a
 * scaffold step replaced it), Node's `process.cwd()` throws
 * `ENOENT: uv_cwd`. That single failure used to cascade into every spawn
 * (`spawn /bin/sh ENOENT`, `spawn nmap ENOENT`) because the child inherits
 * the parent cwd, and it crashed `clai` at startup because config defaults
 * call process.cwd() at module load.
 *
 * This helper catches that case once, and — when the real cwd is gone —
 * relocates the process to a directory that definitely exists ($HOME, then
 * the filesystem root) via `process.chdir`, so every later `process.cwd()`,
 * `spawn`, and relative-path resolution keeps working.
 */
export function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return recoverCwd();
  }
}

/**
 * True when the real working directory is currently unreadable (deleted or
 * permission-revoked). Callers can surface a one-time warning to the user.
 */
export function cwdIsBroken(): boolean {
  try {
    process.cwd();
    return false;
  } catch {
    return true;
  }
}

let recovered = false;

/**
 * Move the process to the first directory that exists from the fallback
 * chain and return it. Idempotent and side-effect-light: only chdir's when
 * the current cwd is actually broken.
 */
export function recoverCwd(): string {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    homedir(),
    process.env.TMPDIR,
    "/tmp",
    "/",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue;
      process.chdir(dir);
      recovered = true;
      return dir;
    } catch {
      // try the next candidate
    }
  }
  // Last resort — return $HOME string even if we couldn't chdir; callers
  // pass this to spawn({cwd}) which will then surface a clear error rather
  // than the cryptic uv_cwd throw.
  return homedir() || "/";
}

/** Whether recoverCwd() has relocated the process during this run. */
export function didRecoverCwd(): boolean {
  return recovered;
}
