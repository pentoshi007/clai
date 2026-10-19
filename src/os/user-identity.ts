import { execFileSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { isatty } from "node:tty";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface InvokingUser {
  readonly uid: number;
  readonly gid: number;
  readonly username: string;
  readonly home: string;
}

interface InvokingSource {
  readonly uid?: number | undefined;
  readonly username?: string | undefined;
  readonly required: boolean;
}

const UNSET_LOGIN_UID = 4_294_967_295;
const USERNAME = /^[\w.-]+$/;

let cached: { key: string; user: InvokingUser | undefined } | undefined;

function numericId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function userId(value: string | undefined): number | undefined {
  const id = numericId(value);
  return id ? id : undefined;
}

function passwdUser(raw: string, match: { uid?: number | undefined; username?: string | undefined }): InvokingUser | undefined {
  for (const line of raw.split("\n")) {
    const [username, , rawUid, groupId, , home] = line.split(":");
    const uid = numericId(rawUid);
    const gid = numericId(groupId);
    if (uid === undefined || gid === undefined || !username || !home || !isAbsolute(home)) continue;
    if ((match.uid === undefined || match.uid === uid) && (match.username === undefined || match.username === username)) {
      return { uid, gid, username, home };
    }
  }
  return undefined;
}

function linuxUser(match: { uid?: number | undefined; username?: string | undefined }): InvokingUser | undefined {
  const local = passwdUser(readFileSync("/etc/passwd", "utf8"), match);
  if (local) return local;
  const key = match.uid !== undefined ? String(match.uid) : match.username!;
  return passwdUser(execFileSync("/usr/bin/getent", ["passwd", key], { encoding: "utf8", timeout: 1_000 }), match);
}

function macUsername(uid: number): string | undefined {
  const raw = execFileSync("/usr/bin/dscl", [".", "-search", "/Users", "UniqueID", String(uid)], { encoding: "utf8", timeout: 1_000 });
  const username = /^(\S+)/.exec(raw)?.[1];
  return username && USERNAME.test(username) ? username : undefined;
}

function macUser(match: { uid?: number | undefined; username?: string | undefined }): InvokingUser | undefined {
  const username = match.username ?? (match.uid !== undefined ? macUsername(match.uid) : undefined);
  if (!username || !USERNAME.test(username)) return undefined;
  const raw = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${username}`, "NFSHomeDirectory", "UniqueID", "PrimaryGroupID"], { encoding: "utf8", timeout: 1_000 });
  const home = /^NFSHomeDirectory:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  const uid = numericId(/^UniqueID:\s*(\d+)$/m.exec(raw)?.[1]);
  const gid = numericId(/^PrimaryGroupID:\s*(\d+)$/m.exec(raw)?.[1]);
  if (uid === undefined || gid === undefined || !home || !isAbsolute(home)) return undefined;
  return match.uid === undefined || match.uid === uid ? { uid, gid, username, home } : undefined;
}

function lookupUser(source: InvokingSource): InvokingUser | undefined {
  const user = process.platform === "darwin"
    ? macUser({ uid: source.uid, username: source.username })
    : linuxUser(source.uid !== undefined ? { uid: source.uid } : { username: source.username });
  return user && user.uid !== 0 ? user : undefined;
}

function loginUid(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const id = userId(readFileSync("/proc/self/loginuid", "utf8").trim());
    return id === UNSET_LOGIN_UID ? undefined : id;
  } catch {
    return undefined;
  }
}

function terminalOwner(): number | undefined {
  for (const fd of [0, 1, 2]) {
    if (!isatty(fd)) continue;
    try {
      const owner = fstatSync(fd).uid;
      if (owner > 0) return owner;
    } catch {}
  }
  return undefined;
}

function invokingSource(): InvokingSource | undefined {
  const sudo = userId(process.env.SUDO_UID);
  if (sudo) {
    const username = process.env.SUDO_USER;
    return { uid: sudo, ...(username && USERNAME.test(username) ? { username } : {}), required: true };
  }
  const pkexec = userId(process.env.PKEXEC_UID);
  if (pkexec) return { uid: pkexec, required: true };
  const doas = process.env.DOAS_USER;
  if (doas && USERNAME.test(doas) && doas !== "root") return { username: doas, required: true };
  const login = loginUid();
  if (login) return { uid: login, required: false };
  const owner = terminalOwner();
  return owner ? { uid: owner, required: false } : undefined;
}

export function getInvokingUser(): InvokingUser | undefined {
  if (process.platform === "win32" || process.getuid?.() !== 0) return undefined;
  const source = invokingSource();
  if (!source) return undefined;
  const key = `${process.platform}:${source.uid ?? ""}:${source.username ?? ""}:${source.required}`;
  if (cached?.key === key) return cached.user;
  let user: InvokingUser | undefined;
  try { user = lookupUser(source); } catch {}
  if (!user && source.required) {
    throw new Error(`Cannot resolve the invoking user (${source.username ?? source.uid}); refusing to create a separate root history store.`);
  }
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
