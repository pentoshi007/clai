import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/one-shot-fetch.mjs', import.meta.url));
const directories: string[] = [];

async function isolated(): Promise<{ path: string; env: NodeJS.ProcessEnv }> {
  const path = await mkdtemp(join(tmpdir(), 'clai-one-shot-history-'));
  directories.push(path);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of ['CLAI_CONFIG_DIR', 'CLAI_DATA_DIR', 'CLAI_HISTORY_DIR', 'CLAI_PLAN_DIR', 'CLAI_LOG_DIR', 'CLAI_ARTIFACT_DIR', 'CLAI_JOBS_DIR', 'CLAI_MCP_HOME']) {
    env[key] = path;
  }
  return { path, env };
}

function record(id: string, content: string): string {
  return JSON.stringify({
    id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: root, revision: 1, messages: [{ role: 'user', content }],
  }) + '\n';
}

function cliArgs(extra: string[] = []): string[] {
  return ['--import', fixture, '--import', 'tsx', 'src/index.ts', '--provider', 'free', '--model', 'big-pickle', '--mode', 'ask', '--quiet', ...extra, 'Reply with ONE_SHOT_OK'];
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('one-shot history shutdown', () => {
  it('prints the answer and exits naturally with the default heap', async () => {
    const { path, env } = await isolated();
    const result = await run(process.execPath, cliArgs(), { cwd: root, env, timeout: 30_000 });
    expect(result.stdout).toContain('ONE_SHOT_OK');
    expect(result.stderr).not.toContain('heap');
    const saved = await readFile(join(path, 'history.jsonl'), 'utf8');
    expect(saved).toContain('ONE_SHOT_OK');
  }, 35_000);

  it('honors --no-history without touching existing orphan snapshots', async () => {
    const { path, env } = await isolated();
    const history = join(path, 'history.jsonl');
    const orphan = `${history}.99999.unfinished.tmp`;
    const original = record('existing', 'existing history');
    await writeFile(history, original);
    await writeFile(orphan, record('orphan', 'pending recovery'));
    const result = await run(process.execPath, cliArgs(['--no-history']), { cwd: root, env, timeout: 30_000 });
    expect(result.stdout).toContain('ONE_SHOT_OK');
    expect(await readFile(history, 'utf8')).toBe(original);
    expect((await stat(orphan)).size).toBeGreaterThan(0);
  }, 35_000);

  it('recovers large history after the answer without retaining all message bodies', async () => {
    const { path, env } = await isolated();
    const history = join(path, 'history.jsonl');
    const handle = await open(history, 'w');
    try {
      const body = 'history body '.repeat(45_000);
      for (let i = 0; i < 340; i++) await handle.writeFile(record(`old-${i}`, body));
    } finally {
      await handle.close();
    }
    await writeFile(`${history}.99999.unfinished.tmp`, record('recovered', 'recovered message'));
    const result = await run(process.execPath, ['--max-old-space-size=128', ...cliArgs()], { cwd: root, env, timeout: 60_000 });
    expect(result.stdout).toContain('ONE_SHOT_OK');
    expect(result.stderr).not.toContain('heap');
    const index = JSON.parse(await readFile(join(path, 'history.index.json'), 'utf8')) as { entries: { id: string }[] };
    expect(index.entries).toHaveLength(342);
    expect(index.entries.some((entry) => entry.id === 'recovered')).toBe(true);
    await expect(stat(`${history}.99999.unfinished.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 65_000);
});
