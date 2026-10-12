export const sourceApplyWorker = String.raw`import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const key of ['root', 'stage', 'worktree', 'head', 'commit', 'runtime', 'version']) {
  if (typeof data[key] !== 'string' || !data[key]) throw new Error('Invalid source-update task');
}
function command(file, args) {
  const result = spawnSync(file, args, { cwd: data.root, encoding: 'utf8', timeout: 30000, maxBuffer: 16384, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error((result.error?.message || result.stderr || 'Source update command failed').slice(-1024));
  return result.stdout.trim();
}
const moved = [];
let merged = false;
let preserve = false;
try {
  const changes = command('git', ['status', '--porcelain', '--', '.', ':(exclude)' + basename(data.stage)]);
  if (changes || command('git', ['rev-parse', 'HEAD']) !== data.head) throw new Error('Checkout changed while the update was building; existing files were kept');
  command('git', ['merge', '--ff-only', data.commit]);
  merged = true;
  for (const name of ['node_modules', 'dist']) {
    const target = join(data.root, name);
    const backup = join(data.stage, 'previous-' + name);
    const entry = { target, backup, previous: existsSync(target), installed: false };
    moved.push(entry);
    if (entry.previous) renameSync(target, backup);
    renameSync(join(data.worktree, name), target);
    entry.installed = true;
  }
  const actual = command(data.runtime, [join(data.root, 'dist', 'index.js'), '--version']).replace(/^clai\s+|^v/g, '');
  if (actual !== data.version) throw new Error('Source-update runtime verification failed: ' + actual);
  process.stdout.write(actual + '\n');
} catch (error) {
  try {
    for (const entry of moved.reverse()) {
      if (entry.installed) rmSync(entry.target, { recursive: true, force: true });
      if (entry.previous && existsSync(entry.backup)) renameSync(entry.backup, entry.target);
    }
    if (merged) command('git', ['reset', '--keep', data.head]);
  } catch (rollbackError) {
    preserve = true;
    writeFileSync(join(data.stage, 'recovery'), 'Previous files retained for recovery');
    process.stderr.write('Rollback could not finish. Recovery files: ' + data.stage + '\n' + String(rollbackError) + '\n');
  }
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
} finally {
  if (!preserve) {
    try { command('git', ['worktree', 'remove', '--force', data.worktree]); } catch {}
    try { rmSync(data.stage, { recursive: true, force: true }); } catch {}
  }
}
`;

export const sourceCleanupWorker = String.raw`import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const payload = process.argv.at(-1);
if (!payload || !existsSync(payload)) process.exit(0);
const data = JSON.parse(readFileSync(payload, 'utf8'));
for (const key of ['root', 'stage', 'worktree']) {
  if (typeof data[key] !== 'string' || !data[key]) throw new Error('Invalid source-cleanup task');
}
if (dirname(resolve(data.stage)) !== resolve(data.root) || !basename(data.stage).startsWith('.clai-update-') || resolve(data.worktree) !== resolve(join(data.stage, 'worktree'))) throw new Error('Invalid source staging directory');
if (existsSync(join(data.stage, 'recovery'))) process.exit(0);
if (existsSync(data.worktree)) {
  const result = spawnSync('git', ['worktree', 'remove', '--force', data.worktree], { cwd: data.root, timeout: 30000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error((result.error?.message || result.stderr || 'Could not clean source worktree').slice(-1024));
}
rmSync(data.stage, { recursive: true, force: true });
`;
