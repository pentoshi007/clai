import { describe, expect, it } from 'vitest';
import { detectSystem, isWindows } from '../src/os/detect.js';

describe('OS detection', () => {
  it('returns a valid system info object', () => {
    const info = detectSystem();
    expect(info.platform).toBeTruthy();
    expect(info.osName).toBeTruthy();
    expect(info.arch).toBeTruthy();
    expect(info.release).toBeTruthy();
    expect(info.cwd).toBeTruthy();
  });

  it('detects macOS platform correctly', () => {
    const info = detectSystem();
    if (process.platform === 'darwin') {
      expect(info.osName).toBe('macOS');
    }
  });

  it('reports shell from environment', () => {
    const info = detectSystem();
    expect(info.shell).toBeTruthy();
    expect(info.shell).not.toBe('unknown');
  });

  it('isWindows returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean');
  });
});
