import { mkdir, readdir, rename, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { redactSecrets } from '../llm/provider.js';

const logsDir = join(homedir(), '.clai', 'logs');
const maxLogBytes = 10 * 1024 * 1024;

function today(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

export function getLogPath(): string {
  return join(logsDir, `clai-${today()}.log`);
}

async function rotateIfNeeded(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const info = await stat(path);
  if (info.size < maxLogBytes) return;
  const siblings = await readdir(logsDir).catch(() => []);
  const count = siblings.filter((name) => name.startsWith(`clai-${today()}.log.`)).length + 1;
  await rename(path, `${path}.${count}`);
}

export async function auditLog(event: string, payload: unknown = {}): Promise<void> {
  await mkdir(logsDir, { recursive: true });
  const path = getLogPath();
  await rotateIfNeeded(path);
  const entry = redactSecrets(JSON.stringify({ at: new Date().toISOString(), event, payload }));
  await appendFile(path, `${entry}\n`, 'utf8');
}
