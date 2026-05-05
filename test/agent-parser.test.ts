import { describe, expect, it } from 'vitest';
import { parseToolCall } from '../src/agent/runner.js';

describe('agent tool-call parser', () => {
  it('extracts tool calls from fenced code blocks', () => {
    const text = 'I will run the command.\n```tool\n{"name":"shell.exec","args":{"command":"ls -la"}}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('shell.exec');
    expect(call!.args).toEqual({ command: 'ls -la' });
  });

  it('extracts tool calls from XML-style tags', () => {
    const text = 'Planning.\n<tool_call>{"name":"sysinfo","args":{}}</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('sysinfo');
    expect(call!.args).toEqual({});
  });

  it('extracts tool calls from ### heading format', () => {
    const text = 'I will check your IP.\n### tool\n{"name":"shell.exec","args":{"command":"curl ifconfig.me"}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('shell.exec');
    expect(call!.args).toEqual({ command: 'curl ifconfig.me' });
  });

  it('extracts tool calls from **tool** bold format', () => {
    const text = 'Checking.\n**tool**\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('sysinfo');
  });

  it('extracts from ```json fenced blocks', () => {
    const text = 'Running:\n```json\n{"name":"http.fetch","args":{"url":"https://api.ipify.org"}}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('http.fetch');
  });

  it('extracts trailing JSON object', () => {
    const text = 'Let me check.\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('sysinfo');
  });

  it('returns undefined for plain text without tool calls', () => {
    const text = 'Here is the answer: just run ls.';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it('returns undefined for malformed JSON in tool block', () => {
    const text = '```tool\n{invalid json}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it('returns undefined when name is missing', () => {
    const text = '```tool\n{"args":{"command":"ls"}}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it('returns undefined when args is missing', () => {
    const text = '```tool\n{"name":"shell.exec"}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it('handles multiline tool JSON', () => {
    const text = '```tool\n{\n  "name": "fs.read",\n  "args": {\n    "path": "/tmp/test.txt"\n  }\n}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('fs.read');
    expect(call!.args).toEqual({ path: '/tmp/test.txt' });
  });
});
