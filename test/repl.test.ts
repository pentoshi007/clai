import { describe, expect, it } from 'vitest';
import { getKnownModels, getSlashCommandSuggestions } from '../src/repl.js';

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

describe('REPL known model lists', () => {
  it('does not offer decommissioned Groq models', () => {
    const models = getKnownModels('groq');
    expect(models).not.toContain('gemma2-9b-it');
    expect(models).not.toContain('moonshotai/kimi-k2-instruct');
    expect(models).not.toContain('deepseek-r1-distill-llama-70b');
    expect(models).toContain('qwen/qwen3-32b');
  });

  it('does not offer NVIDIA models observed as unavailable or streaming-incompatible', () => {
    const models = getKnownModels('nvidia');
    expect(models).not.toContain('moonshotai/kimi-k2.6');
    expect(models).not.toContain('moonshotai/kimi-k2-instruct');
    expect(models).not.toContain('minimaxai/minimax-m2.7');
    expect(models).not.toContain('z-ai/glm-5.1');
    expect(models[0]).toBe('nvidia/llama-3.3-nemotron-super-49b-v1');
  });
});
