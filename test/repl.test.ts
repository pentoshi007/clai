import { describe, expect, it } from 'vitest';
import { getKnownModels, getSlashCommandSuggestions } from '../src/repl.js';

describe('REPL slash command suggestions', () => {
  it('lists commands after a bare slash', () => {
    // A bare '/' no longer triggers suggestions (prevents accidental
    // /ask submission). At least one character is required.
    expect(getSlashCommandSuggestions('/')).toEqual([]);

    // With one character, suggestions should appear.
    const commands = getSlashCommandSuggestions('/a').map((item) => item.command);
    expect(commands).toContain('/ask');
    expect(commands).toContain('/agent');
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

  it('exposes the documented NVIDIA NIM models with the new gpt-oss default at the top', () => {
    const models = getKnownModels('nvidia');
    expect(models[0]).toBe('openai/gpt-oss-20b');
    expect(models).toContain('moonshotai/kimi-k2.6');
    expect(models).toContain('deepseek-ai/deepseek-v4-flash');
    expect(models).toContain('deepseek-ai/deepseek-v4-pro');
    expect(models).toContain('z-ai/glm-5.1');
    expect(models).toContain('mistralai/mistral-medium-3.5-128b');
    expect(models).toContain('google/gemma-4-31b-it');
  });

  it('exposes only the documented AgentRouter models (5 listed in provider docs)', () => {
    const models = getKnownModels('agentrouter');
    expect(models).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.1',
    ]);
  });
});
