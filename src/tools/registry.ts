import { detectSystem } from '../os/detect.js';
import { detectPackageManager } from '../os/pkgmgr.js';
import type { ToolCall, ToolResult } from '../types.js';
import { fsList, fsRead, fsSearch, fsWrite } from './fs.js';
import { httpFetch } from './http.js';
import { shellExec } from './shell.js';

export interface ToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
}

export type ToolHandler = (args: Record<string, unknown>, options?: ToolRunOptions) => Promise<ToolResult>;

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Tool argument "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

function safeToolName(value: string): string {
  if (!/^[A-Za-z0-9_.+-]+$/.test(value)) {
    throw new Error(`Unsafe package/tool name: ${value}`);
  }
  return value;
}

function safeTarget(value: string): string {
  if (!/^[A-Za-z0-9_.:-]+(?:\/\d{1,3})?$/.test(value)) {
    throw new Error(`Unsafe target syntax: ${value}`);
  }
  return value;
}

function safePorts(value: string): string {
  if (!/^[A-Za-z0-9,:-]+$/.test(value)) {
    throw new Error(`Unsafe port syntax: ${value}`);
  }
  return value;
}

function safeFlagTokens(value: string): string[] {
  if (!value.trim()) return [];
  return value.trim().split(/\s+/).map((token) => {
    if (!/^-{1,2}[A-Za-z0-9][A-Za-z0-9_.:=,+/-]*$/.test(token)) {
      throw new Error(`Unsafe flag syntax: ${token}`);
    }
    return token;
  });
}

function commandLabel(command: string, argv: string[]): string {
  return [command, ...argv].join(' ');
}

export const toolRegistry: Record<string, ToolHandler> = {
  async 'shell.exec'(args, options) {
    return shellExec({ command: requireString(args, 'command'), cwd: optionalString(args, 'cwd'), timeoutMs: optionalNumber(args, 'timeoutMs'), signal: options?.signal, onOutput: options?.onOutput });
  },
  async 'fs.read'(args) {
    return fsRead(requireString(args, 'path'));
  },
  async 'fs.write'(args) {
    return fsWrite(requireString(args, 'path'), requireString(args, 'content'));
  },
  async 'fs.list'(args) {
    return fsList(optionalString(args, 'path') ?? process.cwd());
  },
  async 'fs.search'(args) {
    return fsSearch(requireString(args, 'pattern'), optionalString(args, 'path'));
  },
  async 'pkg.install'(args, options) {
    const tool = safeToolName(requireString(args, 'tool'));
    const pkgmgr = await detectPackageManager();
    return shellExec({ command: pkgmgr.installCommand(tool), signal: options?.signal, onOutput: options?.onOutput });
  },
  async 'net.scan'(args, options) {
    const target = safeTarget(requireString(args, 'target'));
    const ports = optionalString(args, 'ports');
    const flags = safeFlagTokens(optionalString(args, 'flags') ?? '');
    const argv = ports
      ? ['-p', safePorts(ports), ...flags, target]
      : [...flags, target];
    return shellExec({ command: 'nmap', argv, shell: false, timeoutMs: 300_000, signal: options?.signal, onOutput: options?.onOutput });
  },
  async 'http.fetch'(args, options) {
    const headers = args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)
      ? args.headers as Record<string, string>
      : undefined;
    return httpFetch(requireString(args, 'url'), {
      method: optionalString(args, 'method'),
      body: optionalString(args, 'body'),
      headers,
      maxBytes: optionalNumber(args, 'maxBytes'),
      signal: options?.signal,
    });
  },
  async sysinfo() {
    return { ok: true, output: JSON.stringify(detectSystem(), null, 2) };
  },
  async 'pentest.recon'(args, options) {
    const target = safeTarget(requireString(args, 'target'));
    const commands = [
      { command: 'whois', argv: [target] },
      { command: 'dig', argv: [target, 'ANY', '+noall', '+answer'] },
      { command: 'nmap', argv: ['-sV', '--top-ports', '100', target] },
    ];
    const outputs: string[] = [];
    for (const { command, argv } of commands) {
      if (options?.signal?.aborted) break;
      // Announce each sub-step so users see progress through long recons.
      const label = commandLabel(command, argv);
      options?.onOutput?.(`\n$ ${label}\n`, "stdout");
      const result = await shellExec({ command, argv, shell: false, timeoutMs: 180_000, signal: options?.signal, onOutput: options?.onOutput });
      outputs.push(`$ ${label}\n${result.output}`);
      if (options?.signal?.aborted) break;
    }
    return {
      ok: !options?.signal?.aborted,
      output: options?.signal?.aborted ? `${outputs.join('\n\n')}\n\nCommand aborted.`.trim() : outputs.join('\n\n'),
      exitCode: options?.signal?.aborted ? 130 : 0,
    };
  },
};

export function availableToolNames(): string[] {
  return Object.keys(toolRegistry);
}

export async function runToolCall(call: ToolCall, options: ToolRunOptions = {}): Promise<ToolResult> {
  const handler = toolRegistry[call.name];
  if (!handler) {
    throw new Error(`Unknown tool: ${call.name}`);
  }
  return handler(call.args, options);
}
