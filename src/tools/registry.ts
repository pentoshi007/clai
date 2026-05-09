import { detectSystem } from '../os/detect.js';
import { detectPackageManager } from '../os/pkgmgr.js';
import type { ToolCall, ToolResult } from '../types.js';
import { fsList, fsRead, fsSearch, fsWrite } from './fs.js';
import { httpFetch } from './http.js';
import { shellExec } from './shell.js';

export interface ToolRunOptions {
  signal?: AbortSignal | undefined;
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

export const toolRegistry: Record<string, ToolHandler> = {
  async 'shell.exec'(args, options) {
    return shellExec({ command: requireString(args, 'command'), cwd: optionalString(args, 'cwd'), timeoutMs: optionalNumber(args, 'timeoutMs'), signal: options?.signal });
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
    const tool = requireString(args, 'tool');
    const pkgmgr = await detectPackageManager();
    return shellExec({ command: pkgmgr.installCommand(tool), signal: options?.signal });
  },
  async 'net.scan'(args, options) {
    const target = requireString(args, 'target');
    const ports = optionalString(args, 'ports');
    const command = ports ? `nmap -p ${ports} ${target}` : `nmap ${target}`;
    return shellExec({ command, timeoutMs: 120_000, signal: options?.signal });
  },
  async 'http.fetch'(args) {
    return httpFetch(requireString(args, 'url'), {
      method: optionalString(args, 'method'),
      body: optionalString(args, 'body'),
      maxBytes: optionalNumber(args, 'maxBytes'),
    });
  },
  async sysinfo() {
    return { ok: true, output: JSON.stringify(detectSystem(), null, 2) };
  },
  async 'pentest.recon'(args, options) {
    const target = requireString(args, 'target');
    const commands = [`whois ${target}`, `dig ${target}`, `nmap --top-ports 100 ${target}`];
    const outputs: string[] = [];
    for (const command of commands) {
      if (options?.signal?.aborted) break;
      const result = await shellExec({ command, timeoutMs: 120_000, signal: options?.signal });
      outputs.push(`$ ${command}\n${result.output}`);
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
