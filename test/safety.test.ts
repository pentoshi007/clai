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

  it('auto-approves read-only shell commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'ls -la' } });
    expect(result.level).toBe('safe');
  });

  it('requires confirmation for mutating shell commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'mv file.txt /tmp/' } });
    expect(result.level).toBe('confirm');
  });

  it('blocks public scans without explicit ownership flag', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'nmap 8.8.8.8' } });
    expect(result.level).toBe('block');
  });

  it('requires confirmation for pentest scan tools even against private targets', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'gobuster dir -u http://192.168.1.1 -w /usr/share/wordlists/common.txt' } });
    expect(result.level).toBe('confirm');
  });

  it('requires confirmation for ffuf', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'ffuf -u http://192.168.1.1/FUZZ -w wordlist.txt' } });
    expect(result.level).toBe('confirm');
  });

  it('does not auto-approve secret file reads through shell', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'cat ~/.clai/keys.json' } });
    expect(result.level).not.toBe('safe');
  });

  it('does not auto-approve env dumping', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'env' } });
    expect(result.level).toBe('confirm');
  });

  it('requires confirmation for mutating HTTP fetches', () => {
    const result = classifyToolCall({ name: 'http.fetch', args: { url: 'https://example.com/api', method: 'POST', body: '{}' } });
    expect(result.level).toBe('confirm');
  });

  it('blocks metadata endpoint fetches', () => {
    const result = classifyToolCall({ name: 'http.fetch', args: { url: 'http://169.254.169.254/latest/meta-data/' } });
    expect(result.level).toBe('block');
  });

  it('auto-approves simple public GET curl commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'curl -s ifconfig.me' } });
    expect(result.level).toBe('safe');
  });

  it('requires confirmation for mutating curl commands', () => {
    const result = classifyToolCall({ name: 'shell.exec', args: { command: 'curl -X POST https://example.com -d a=b' } });
    expect(result.level).toBe('confirm');
  });

  it('blocks public domain scans unless ownership is structured', () => {
    const blocked = classifyToolCall({ name: 'net.scan', args: { target: 'example.com' } });
    const allowed = classifyToolCall({ name: 'net.scan', args: { target: 'example.com', iOwnThis: true } });
    expect(blocked.level).toBe('block');
    expect(allowed.level).toBe('confirm');
  });
});
