import { describe, expect, it } from 'vitest';
import { classifyToolCall, isPrivateIpv4 } from '../src/safety/classifier.js';


describe('safety classifier', () => {
  it('allows private IPv4 targets', () => {
    expect(isPrivateIpv4('192.168.1.10')).toBe(true);
    expect(isPrivateIpv4('10.0.0.1/24')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
  });

  it('blocks destructive shell commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'rm -rf /' } });
    expect(result.level).toBe('block');
  });

  it('requires confirmation for normal shell commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'ls -la' } });
    expect(result.level).toBe('confirm');
  });

  it('blocks public scans without explicit ownership flag', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'nmap 8.8.8.8' } });
    expect(result.level).toBe('block');
  });
});
