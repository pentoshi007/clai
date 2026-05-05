import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const contextFile = join(process.cwd(), '.clai', 'context.md');

export async function loadProjectContext(): Promise<string | undefined> {
  if (!existsSync(contextFile)) return undefined;
  const content = await readFile(contextFile, 'utf8');
  return content.trim().length > 0 ? content.trim() : undefined;
}

export function getProjectContextPath(): string {
  return contextFile;
}
