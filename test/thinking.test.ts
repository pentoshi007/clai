import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearThinking,
  createThinkingStreamParser,
  getLastThinking,
  rememberThinkingFromText,
  stripThinking,
} from '../src/ui/thinking.js';
import {
  REASONING_CLOSE,
  REASONING_OPEN,
} from '../src/llm/reasoning-marker.js';

describe('thinking helpers', () => {
  beforeEach(() => {
    clearThinking();
  });

  it('strips a leading self-tagged think block from text', () => {
    const result = stripThinking('<think>secret</think> world');

    expect(result.visible).toBe('world');
    expect(result.hasThinking).toBe(true);
    expect(result.thinkContent).toBe('secret');
  });

  it('strips an unclosed leading think block from text', () => {
    const result = stripThinking('<think>still thinking');

    expect(result.visible).toBe('');
    expect(result.hasThinking).toBe(true);
    expect(result.thinkContent).toBe('still thinking');
  });

  it('parses a streamed leading think tag split across chunks', () => {
    const visible: string[] = [];
    const parser = createThinkingStreamParser((text) => visible.push(text));

    parser.push('<thi');
    parser.push('nk>secret</th');
    parser.push('ink> world');
    const result = parser.finish();

    expect(visible.join('').trim()).toBe('world');
    expect(result.thinkContent).toBe('secret');
    expect(getLastThinking()).toBe('secret');
  });

  it('keeps think tags the model wrote inside its answer as literal text', () => {
    const answer =
      'Treat a user-typed <think> in prose as text, and </think> likewise.';

    expect(stripThinking(answer)).toEqual({
      visible: answer,
      hasThinking: false,
      thinkContent: '',
    });
  });

  it('never diverts prose containing the words thinking or response', () => {
    const answer =
      'I checked the thinking parser and the response path looks fine.';

    expect(stripThinking(answer)).toEqual({
      visible: answer,
      hasThinking: false,
      thinkContent: '',
    });
  });

  it('keeps reasoning intact when the reasoning itself quotes a close tag', () => {
    const wire = `${REASONING_OPEN}I must mention </think> twice.${REASONING_CLOSE}Final answer.`;

    expect(stripThinking(wire)).toEqual({
      visible: 'Final answer.',
      hasThinking: true,
      thinkContent: 'I must mention </think> twice.',
    });
  });

  it('splits provider reasoning from an answer that quotes think tags', () => {
    const visible: string[] = [];
    const reasoning: string[] = [];
    const parser = createThinkingStreamParser(
      (text) => visible.push(text),
      (text) => reasoning.push(text),
    );

    parser.push(REASONING_OPEN);
    parser.push('Need to mention <think> and </think> in the answer.');
    parser.push(REASONING_CLOSE);
    parser.push('Use <think> literally, and </think> too.');
    const result = parser.finish();

    expect(reasoning.join('')).toBe(
      'Need to mention <think> and </think> in the answer.',
    );
    expect(visible.join('')).toBe('Use <think> literally, and </think> too.');
    expect(result.visible).toBe('Use <think> literally, and </think> too.');
  });

  it('opens a separate block when reasoning resumes after visible text', () => {
    const order: string[] = [];
    const parser = createThinkingStreamParser(
      (text) => order.push(`V:${text}`),
      (text) => order.push(`R:${text}`),
    );

    parser.push(`${REASONING_OPEN}first thought${REASONING_CLOSE}`);
    parser.push('Here is the answer. ');
    parser.push(`${REASONING_OPEN}second thought${REASONING_CLOSE}`);
    parser.push('More answer.');
    const result = parser.finish();

    expect(order).toEqual([
      'R:first thought',
      'V:Here is the answer. ',
      'R:second thought',
      'V:More answer.',
    ]);
    expect(result.visible).toBe('Here is the answer. More answer.');
    expect(result.thinkContent).toBe('first thought\n\nsecond thought');
  });

  it('never emits reasoning markers as visible text', () => {
    const visible: string[] = [];
    const parser = createThinkingStreamParser((text) => visible.push(text));

    parser.push(`${REASONING_CLOSE}stray close`);
    parser.finish();

    expect(visible.join('')).toBe('stray close');
  });

  it('remembers thinking while returning visible text', () => {
    const result = rememberThinkingFromText('<think>hidden</think>shown');

    expect(result.visible).toBe('shown');
    expect(getLastThinking()).toBe('hidden');
  });

  it('recognizes the <thinking> delimiters used by Kimi-compatible routes', () => {
    expect(stripThinking('<thinking>check the config</thinking>Done.')).toEqual({
      visible: 'Done.',
      hasThinking: true,
      thinkContent: 'check the config',
    });
  });

  it('keeps several leading self-tagged blocks and the answer apart', () => {
    expect(stripThinking('<think>a</think><think>b</think>Answer.')).toEqual({
      visible: 'Answer.',
      hasThinking: true,
      thinkContent: 'a\n\nb',
    });
  });

  it('streams Kimi-compatible <thinking> tags split across chunks in place', () => {
    const visible: string[] = [];
    const reasoning: string[] = [];
    const parser = createThinkingStreamParser(
      (text) => visible.push(text),
      (text) => reasoning.push(text),
    );

    parser.push('<think');
    parser.push('ing>check');
    parser.push(' the config</think');
    parser.push('ing>Done.');
    const result = parser.finish();

    expect(reasoning.join('')).toBe('check the config');
    expect(visible.join('')).toBe('Done.');
    expect(result).toMatchObject({
      visible: 'Done.',
      thinkContent: 'check the config',
    });
  });

  it('can suppress streamed thinking without storing it as response reasoning', () => {
    const visible: string[] = [];
    const parser = createThinkingStreamParser(
      (text) => visible.push(text),
      undefined,
      { remember: false },
    );

    parser.push('<think>private compaction chain</think>');
    parser.push('## Visible summary');
    const result = parser.finish();

    expect(visible.join('')).toBe('## Visible summary');
    expect(result.thinkContent).toBe('private compaction chain');
    expect(getLastThinking()).toBe('');
  });
});
