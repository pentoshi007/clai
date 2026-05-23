import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { limitProjectContext } from '../context/manager.js';

export async function loadProjectContext(): Promise<string | undefined> {
  const contextFile = join(process.cwd(), '.clai', 'context.md');
  if (!existsSync(contextFile)) return undefined;
  const content = await readFile(contextFile, 'utf8');
  const trimmed = content.trim();
  return trimmed.length > 0 ? limitProjectContext(trimmed) : undefined;
}

export function getProjectContextPath(): string {
  return join(process.cwd(), '.clai', 'context.md');
}
