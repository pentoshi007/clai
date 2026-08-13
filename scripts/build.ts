import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

const targets = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
  'bun-windows-arm64',
] as const;

// Bun resolves every @opentui/core-* dynamic import at compile time; force-
// install all platform packages (npm skips non-host os/cpu without --force).
await execa('node', ['scripts/install-opentui-platforms.mjs'], {
  stdio: 'inherit',
});

await mkdir('release', { recursive: true });

for (const target of targets) {
  const exe = target.includes('windows') ? '.exe' : '';
  const out = join('release', `clai-${target}${exe}`);
  console.log(`Building ${out}`);
  await execa(
    'bun',
    [
      'build',
      './src/index.ts',
      '--compile',
      '--target',
      target,
      '--outfile',
      out,
    ],
    {
      stdio: 'inherit',
    },
  );
}
