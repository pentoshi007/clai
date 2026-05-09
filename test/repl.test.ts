import { describe, expect, it } from 'vitest';
import { getSlashCommandSuggestions } from '../src/repl.js';

describe('REPL slash command suggestions', () => {
  it('lists commands after a bare slash', () => {
    const commands = getSlashCommandSuggestions('/').map((item) => item.command);

    expect(commands).toContain('/ask');
    expect(commands).toContain('/model');
    expect(commands).toContain('/help');
  });

  it('filters commands by typed prefix', () => {
    const commands = getSlashCommandSuggestions('/m').map((item) => item.command);

    expect(commands).toEqual(['/model']);
  });

  it('stops suggesting after command arguments begin', () => {
    expect(getSlashCommandSuggestions('/model ')).toEqual([]);
  });
});
