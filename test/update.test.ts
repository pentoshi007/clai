import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCurrentVersion } from '../src/commands/update.js';

describe('update metadata', () => {
  it('matches package.json version', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    expect(getCurrentVersion()).toBe(packageJson.version);
  });
});
