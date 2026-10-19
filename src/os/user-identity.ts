import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface InvokingUser {
  readonly uid: number;
  readonly gid: number;
  readonly username: string;
  readonly home: string;
}

let cached: { key: string; user: InvokingUser } | undefined;

function numericId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function passwdUser(raw: string, uid: number): InvokingUser | undefined {
  for (const line of raw.split("\n")) {
    const [username, , userId, groupId, , home] = line.split(":");
    const gid = numericId(groupId);
    if (numericId(userId) === uid && gid !== undefined && username && home && isAbsolute(home)) {
      return { uid, gid, username, home };
    }
  }
  return undefined;
}

function lookupUser(uid: number): InvokingUser | undefined {
  if (process.platform !== "darwin") {
    const local = passwdUser(readFileSync("/etc/passwd", "utf8"), uid);
    if (local) return local;
    return passwdUser(execFileSync("/usr/bin/getent", ["passwd", String(uid)], { encoding: "utf8", timeout: 1_000 }), uid);
  }
  const username = process.env.SUDO_USER;
  if (!username || !/^[\w.-]+$/.test(username)) return undefined;
  const raw = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory", "UniqueID", "PrimaryGroupID"], { encoding: "utf8", timeout: 1_000 });
  const home = /^NFSHomeDirectory:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  const userId = numericId(/^UniqueID:\s*(\d+)$/m.exec(raw)?.[1]);
  const gid = numericId(/^PrimaryGroupID:\s*(\d+)$/m.exec(raw)?.[1]);
  return userId === uid && gid !== undefined && home && isAbsolute(home) ? { uid, gid, username, home } : undefined;
}

export function getInvokingUser(): InvokingUser | undefined {
  if (process.platform === "win32" || process.getuid?.() !== 0) return undefined;
  const uid = numericId(process.env.SUDO_UID);
  if (uid === undefined || uid === 0) return undefined;
  const key = `${process.platform}:${uid}:${process.env.SUDO_USER ?? ""}`;
  if (cached?.key === key) return cached.user;
  let user: InvokingUser | undefined;
  try { user = lookupUser(uid); } catch {}
  if (!user) throw new Error(`Cannot resolve the invoking sudo user (${uid}); refusing to create a separate root history store.`);
  cached = { key, user };
  return user;
}

export function getUserHome(): string {
  return getInvokingUser()?.home ?? homedir();
}

export function getStorageUid(): number | undefined {
  return getInvokingUser()?.uid ?? process.getuid?.();
}

export function getConfigDirectory(): string | undefined {
  const configured = process.env.CLAI_CONFIG_DIR?.trim();
  if (configured) return configured;
  const user = getInvokingUser();
  if (!user) return undefined;
  if (process.platform === "darwin") return join(user.home, "Library", "Preferences", "clai-nodejs");
  return join(process.env.XDG_CONFIG_HOME || join(user.home, ".config"), "clai-nodejs");
}

export function initializeUserEnvironment(): void {
  const user = getInvokingUser();
  if (!user) return;
  const previousHome = homedir();
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const value = process.env[key];
    if (previousHome !== user.home && value?.startsWith(`${previousHome}/`)) delete process.env[key];
  }
  process.env.HOME = user.home;
  process.env.USER = user.username;
  process.env.LOGNAME = user.username;
  if (process.platform === "darwin") {
    try {
      const path = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 1_000, uid: user.uid, gid: user.gid }).trim();
      if (isAbsolute(path)) process.env.TMPDIR = path;
    } catch {}
  }
}
