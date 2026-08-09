import { describe, expect, it } from 'vitest';
import { compactMessages } from '../../src/agent/context-manager.js';
import { looksLikeTranscriptReplay } from '../../src/agent/compaction-summary.js';
import { sanitizeTitle } from '../../src/agent/session-title.js';
import {
  REASONING_CLOSE,
  REASONING_OPEN,
  wrapReasoning,
} from '../../src/llm/reasoning-marker.js';
import type { ChatMessage } from '../../src/types.js';

const ANSWER =
  'A parser should treat a user-typed <think> in prose as text, and </think> likewise, ' +
  'so the thinking channel and the response channel stay separate.';

describe('reasoning never reaches compaction', () => {
  it('keeps an answer that mentions think tags whole in the retained tail', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'x'.repeat(120_000) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: `${wrapReasoning('private chain')}${ANSWER}` },
    ];

    const out = compactMessages(messages, { budgetTokens: 1_000, keepRecent: 2 });
    const tail = out[out.length - 1]!;

    expect(tail.content).toContain('<think>');
    expect(tail.content).toContain('</think>');
    expect(tail.content).toContain('stay separate.');
    expect(tail.content).not.toContain('private chain');
    expect(tail.content).not.toContain(REASONING_OPEN);
    expect(tail.content).not.toContain(REASONING_CLOSE);
  });

  it('does not truncate the answer at the first literal think tag', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'x'.repeat(120_000) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: ANSWER },
    ];

    const out = compactMessages(messages, { budgetTokens: 1_000, keepRecent: 2 });
    const tail = out[out.length - 1]!;

    expect(tail.content).toBe(ANSWER);
  });

  it('flags a summary that leaked reasoning markers as unusable', () => {
    expect(looksLikeTranscriptReplay(`Memory${REASONING_OPEN}leak`)).toBe(true);
    expect(looksLikeTranscriptReplay('Memory: the user wants X and Y.')).toBe(
      false,
    );
  });

  it('strips provider reasoning out of a generated session title', () => {
    expect(sanitizeTitle(`${wrapReasoning('deciding a title')}Fix the parser`)).toBe(
      'Fix the parser',
    );
    expect(sanitizeTitle('<think>deciding</think>Fix the parser')).toBe(
      'Fix the parser',
    );
  });

  it('keeps a title that legitimately mentions a think tag', () => {
    expect(sanitizeTitle('Handle <think> tags in prose')).toBe(
      'Handle <think> tags in prose',
    );
  });
});
