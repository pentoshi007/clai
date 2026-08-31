import { chownSync, statSync } from "node:fs";
import { chown, stat } from "node:fs/promises";
import { dirname } from "node:path";

export function fixOwnerSync(path: string): void {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0 && process.env.SUDO_UID) {
    const uid = parseInt(process.env.SUDO_UID, 10);
    const gid = process.env.SUDO_GID ? parseInt(process.env.SUDO_GID, 10) : uid;
    if (!isNaN(uid)) {
      try {
        chownSync(path, uid, gid);
      } catch {
      }
    }
  }
}

export async function fixOwner(path: string): Promise<void> {
  if (process.platform === "win32") return;
  if (process.getuid && process.getuid() === 0 && process.env.SUDO_UID) {
    const uid = parseInt(process.env.SUDO_UID, 10);
    const gid = process.env.SUDO_GID ? parseInt(process.env.SUDO_GID, 10) : uid;
    if (!isNaN(uid)) {
      try {
        await chown(path, uid, gid);
      } catch {
      }
    }
  }
}

export function handlePermissionError(err: any): never {
  if (err && err.code === "EACCES") {
    const configPath = err.path || "your configuration directory";

    let chownDir = configPath;
    const claiConfigIndex = configPath.indexOf("clai-nodejs");
    const dotClaiIndex = configPath.indexOf(".clai");
    if (claiConfigIndex !== -1) {
      chownDir = configPath.slice(0, claiConfigIndex + "clai-nodejs".length);
    } else if (dotClaiIndex !== -1) {
      chownDir = configPath.slice(0, dotClaiIndex + ".clai".length);
    } else {
      try {
        chownDir = dirname(configPath);
      } catch {
        chownDir = configPath;
      }
    }

    throw new Error(
      `Permission denied accessing config/history file or directory.\n` +
        `Path: ${configPath}\n` +
        `This usually happens if clai was previously run with sudo or as root, leaving files owned by root.\n` +
        `Fix it by restoring ownership to your current user:\n` +
        `  sudo chown -R $(whoami) "${chownDir}"`,
      { cause: err },
    );
  }
  throw err;
}

export function safeExistsSync(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return false;
    }
    if (err.code === "EACCES") {
      handlePermissionError(err);
    }
    throw err;
  }
}

export async function safeExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return false;
    }
    if (err.code === "EACCES") {
      handlePermissionError(err);
    }
    throw err;
  }
}

