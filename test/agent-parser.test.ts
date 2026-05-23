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

  it('rejects XML-style tags by default', () => {
    const text = 'Planning.\n<tool_call>{"name":"sysinfo","args":{}}</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeUndefined();
  });

  it('rejects ### heading format by default', () => {
    const text = 'I will check your IP.\n### tool\n{"name":"shell.exec","args":{"command":"curl ifconfig.me"}}';
    const call = parseToolCall(text);
    expect(call).toBeUndefined();
  });

  it('rejects **tool** bold format by default', () => {
    const text = 'Checking.\n**tool**\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeUndefined();
  });

  it('rejects ```json fenced blocks by default', () => {
    const text = 'Running:\n```json\n{"name":"http.fetch","args":{"url":"https://api.ipify.org"}}\n```';
    const call = parseToolCall(text);
    expect(call).toBeUndefined();
  });

  it('rejects trailing JSON object by default', () => {
    const text = 'Let me check.\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeUndefined();
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

describe('Kimi K2 sentinel-token tool-call format', () => {
  it('parses Kimi sentinel calls with the functions. prefix', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.sysinfo:1<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('sysinfo');
    expect(call!.args).toEqual({});
  });

  it('parses Kimi sentinel calls without the functions. prefix', () => {
    const text =
      '<|tool_call_begin|>shell.exec:0<|tool_call_argument_begin|>{"command":"uname -a"}<|tool_call_end|>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('shell.exec');
    expect(call!.args).toEqual({ command: 'uname -a' });
  });

  it('parses Kimi sentinel calls without the trailing :index', () => {
    const text =
      '<|tool_call_begin|>fs.read<|tool_call_argument_begin|>{"path":"/etc/os-release"}<|tool_call_end|>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe('fs.read');
    expect(call!.args).toEqual({ path: '/etc/os-release' });
  });

  it('returns undefined for truncated Kimi sentinel calls so the runner can ask for a retry', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_bhell.exec:0<|tool_call_argument_begin|>{"command":"find ..."}<|tool_call_end|><|tool_|>';
    expect(parseToolCall(text)).toBeUndefined();
  });
});
