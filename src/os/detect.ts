import { arch, platform, release, type } from 'node:os';
import { safeCwd } from './cwd.js';

export interface SystemInfo {
  platform: NodeJS.Platform;
  osName: string;
  arch: string;
  release: string;
  shell: string;
  cwd: string;
}

export function detectSystem(): SystemInfo {
  const currentPlatform = platform();
  const osName = currentPlatform === 'darwin' ? 'macOS' : currentPlatform === 'win32' ? 'Windows' : type();
  return {
    platform: currentPlatform,
    osName,
    arch: arch(),
    release: release(),
    shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    cwd: safeCwd(),
  };
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
