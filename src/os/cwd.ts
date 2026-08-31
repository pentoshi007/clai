import { homedir } from "node:os";
import { existsSync } from "node:fs";


export function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return recoverCwd();
  }
}

export function cwdIsBroken(): boolean {
  try {
    process.cwd();
    return false;
  } catch {
    return true;
  }
}

let recovered = false;


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
    }
  }
  
  return homedir() || "/";
}

export function didRecoverCwd(): boolean {
  return recovered;
}
