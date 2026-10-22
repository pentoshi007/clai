import { chownSync, lstatSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getInvokingUser } from "../os/user-identity.js";

export const WORKSPACE_OWNERS_DIR = ".clai-active";

let activeRoot: string | undefined;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
let heartbeatGeneration = 0;

export function isWorkspaceActive(root: string): boolean {
  return resolve(root) === activeRoot;
}

export function protectSessionWorkspace(root: string): void {
  clearSessionWorkspaceActivity();
  activeRoot = resolve(root);
  try {
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const owners = join(root, WORKSPACE_OWNERS_DIR);
    mkdirSync(owners, { mode: 0o700 });
  } catch {
  }
  try {
    const owners = join(root, WORKSPACE_OWNERS_DIR);
    const info = lstatSync(owners);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const owner = join(owners, String(process.pid));
    try {
      writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
    } catch {
    }
    const user = getInvokingUser();
    if (user) {
      try {
        chownSync(owners, user.uid, user.gid);
        chownSync(owner, user.uid, user.gid);
      } catch {
      }
    }
    const now = new Date();
    utimesSync(root, now, now);
  } catch {
  }
  const generation = heartbeatGeneration;
  const schedule = (): void => {
    heartbeat = setTimeout(() => {
      const now = new Date();
      void utimes(root, now, now).catch(() => undefined).finally(() => {
        if (heartbeatGeneration === generation) schedule();
      });
    }, 60 * 60 * 1_000);
    heartbeat.unref();
  };
  schedule();
}

export function clearSessionWorkspaceActivity(): void {
  activeRoot = undefined;
  heartbeatGeneration += 1;
  if (heartbeat) clearTimeout(heartbeat);
  heartbeat = undefined;
}
