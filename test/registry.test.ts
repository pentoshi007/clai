import { describe, expect, it, beforeEach } from 'vitest';
import { availableToolNames, toolRegistry } from '../src/tools/registry.js';
import { updateConfig } from '../src/store/config.js';

describe('tool registry', () => {
  beforeEach(() => {
    // Ensure the test CWD is in the sandbox roots
    updateConfig({ sandboxRoots: [process.cwd()] });
  });

  it('has all expected tools registered', () => {
    const names = availableToolNames();
    expect(names).toContain('shell.exec');
    expect(names).toContain('fs.read');
    expect(names).toContain('fs.write');
    expect(names).toContain('fs.list');
    expect(names).toContain('fs.search');
    expect(names).toContain('pkg.install');
    expect(names).toContain('net.scan');
    expect(names).toContain('http.fetch');
    expect(names).toContain('sysinfo');
    expect(names).toContain('pentest.recon');
  });

  it('sysinfo returns valid JSON with system info', async () => {
    const result = await toolRegistry['sysinfo']!({});
    expect(result.ok).toBe(true);
    const info = JSON.parse(result.output);
    expect(info.platform).toBeTruthy();
    expect(info.arch).toBeTruthy();
    expect(info.osName).toBeTruthy();
  });

  it('fs.list returns directory listing for cwd', async () => {
    const result = await toolRegistry['fs.list']!({});
    expect(result.ok).toBe(true);
    expect(result.output).toContain('package.json');
  });

  it('shell.exec runs a simple command', async () => {
    const result = await toolRegistry['shell.exec']!({ command: 'echo hello' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('shell.exec reports failure for nonexistent command', async () => {
    const result = await toolRegistry['shell.exec']!({ command: 'nonexistent_command_xyz_123' });
    expect(result.ok).toBe(false);
  });

  it('tool handler throws on missing required string arg', async () => {
    await expect(toolRegistry['fs.read']!({})).rejects.toThrow('must be a non-empty string');
  });
});
