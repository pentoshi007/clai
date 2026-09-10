import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSystem, isWindows } from '../src/os/detect.js';

describe('OS detection', () => {
  afterEach(() => vi.unstubAllEnvs());

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
    vi.stubEnv('SHELL', '/bin/test-shell');
    const info = detectSystem();
    expect(info.shell).toBe('/bin/test-shell');
  });

  it('reports an unknown shell when the environment supplies none', () => {
    vi.stubEnv('SHELL', undefined);
    vi.stubEnv('ComSpec', undefined);
    expect(detectSystem().shell).toBe('unknown');
  });

  it('isWindows returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean');
  });
});
