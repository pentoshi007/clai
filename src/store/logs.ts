import { mkdir, readdir, rename, stat, appendFile, rm, chown } from 'node:fs/promises';
import { fixOwner, handlePermissionError } from '../os/permissions.js';

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
  const newPath = `${path}.${count}`;
  await rename(path, newPath);
  await fixOwner(newPath);
}

export async function auditLog(event: string, payload: unknown = {}): Promise<void> {
  try {
    await mkdir(logsDir, { recursive: true });
    await fixOwner(logsDir);
    const path = getLogPath();
    await rotateIfNeeded(path);
    const entry = redactSecrets(JSON.stringify({ at: new Date().toISOString(), event, payload }));
    await appendFile(path, `${entry}\n`, 'utf8');
    await fixOwner(path);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAuditLogs(): Promise<{ removed: number }> {
  if (!existsSync(logsDir)) return { removed: 0 };
  const entries = await readdir(logsDir).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith('clai-')) continue;
    try {
      await rm(join(logsDir, entry), { force: true });
      removed += 1;
    } catch {
      // best-effort: keep going
    }
  }
  return { removed };
}

export function getLogsDir(): string {
  return logsDir;
}

export async function clearArtifacts(): Promise<{ removed: number }> {
  const dir = join(homedir(), '.clai', 'outputs');
  if (!existsSync(dir)) return { removed: 0 };
  const entries = await readdir(dir).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    try {
      await rm(join(dir, entry), { force: true, recursive: true });
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return { removed };
}
