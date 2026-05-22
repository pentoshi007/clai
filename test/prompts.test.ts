import { describe, expect, it } from 'vitest';
import { renderAskSystemPrompt, renderAgentSystemPrompt } from '../src/prompts/index.js';

describe('prompt rendering', () => {
  it('ask prompt contains /ask mode instruction', () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain('/ask mode');
    expect(prompt).toContain('Do NOT execute');
  });

  it('ask prompt includes OS info', () => {
    const prompt = renderAskSystemPrompt();
    // Should have replaced the {{os}} template
    expect(prompt).not.toContain('{{os}}');
    expect(prompt).not.toContain('{{shell}}');
  });

  it('agent prompt includes tool list', () => {
    const prompt = renderAgentSystemPrompt('shell.exec, fs.read, sysinfo');
    expect(prompt).toContain('shell.exec');
    expect(prompt).toContain('fs.read');
    expect(prompt).toContain('sysinfo');
  });

  it('agent prompt has no unresolved template variables', () => {
    const prompt = renderAgentSystemPrompt('shell.exec');
    expect(prompt).not.toContain('{{os}}');
    expect(prompt).not.toContain('{{cwd}}');
    expect(prompt).not.toContain('{{tool_list}}');
    expect(prompt).not.toContain('{{shell}}');
  });

  it('agent prompt contains pentesting authorization reminder', () => {
    const prompt = renderAgentSystemPrompt('net.scan');
    expect(prompt).toContain('permission to test');
  });

  it('agent prompt discourages stale data and vague tool summaries', () => {
    const prompt = renderAgentSystemPrompt('shell.exec');
    expect(prompt).toContain('Do not invent volatile live data');
    expect(prompt).toContain('summarize concrete findings');
    expect(prompt).toContain('For ffuf');
  });
});
