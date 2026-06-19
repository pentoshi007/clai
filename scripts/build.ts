import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

const targets = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-x64',
] as const;

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
      // Ink only imports react-devtools-core when DEV=true (never in a
      // shipped binary). It's not a dependency, so mark it external to keep
      // `bun build --compile` from trying to resolve it.
      '--external',
      'react-devtools-core',
      '--outfile',
      out,
    ],
    {
      stdio: 'inherit',
    },
  );
}
