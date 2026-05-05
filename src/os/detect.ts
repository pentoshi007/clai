import { arch, platform, release, type } from 'node:os';

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
    cwd: process.cwd(),
  };
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
