import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import type { ToolResult } from '../types.js';
import { getConfig } from '../store/config.js';

function ensureAllowed(path: string): string {
  const resolved = resolve(path);
  const roots = getConfig().sandboxRoots.map((root) => resolve(root));
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error(`Path is outside approved roots: ${path}`);
  }
  return resolved;
}

export async function fsRead(path: string): Promise<ToolResult> {
  const resolved = ensureAllowed(path);
  const content = await readFile(resolved, 'utf8');
  return { ok: true, output: content };
}

export async function fsWrite(path: string, content: string): Promise<ToolResult> {
  const resolved = ensureAllowed(path);
  await writeFile(resolved, content, 'utf8');
  return { ok: true, output: `Wrote ${resolved}` };
}

export async function fsList(path: string): Promise<ToolResult> {
  const resolved = ensureAllowed(path);
  const entries = await readdir(resolved, { withFileTypes: true });
  return { ok: true, output: entries.map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n') };
}

export async function fsSearch(pattern: string, path = process.cwd()): Promise<ToolResult> {
  const resolved = ensureAllowed(path);
  try {
    const result = await execa('rg', [pattern, resolved], { reject: false, all: true });
    return { ok: result.exitCode === 0, output: result.all ?? '', exitCode: result.exitCode };
  } catch {
    const result = await execa('grep', ['-R', pattern, resolved], { reject: false, all: true });
    return { ok: result.exitCode === 0, output: result.all ?? '', exitCode: result.exitCode };
  }
}
