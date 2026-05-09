import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearThinking,
  createThinkingStreamParser,
  getLastThinking,
  rememberThinkingFromText,
  stripThinking,
} from '../src/ui/thinking.js';

describe('thinking helpers', () => {
  beforeEach(() => {
    clearThinking();
  });

  it('strips complete think blocks from text', () => {
    const result = stripThinking('hello <think>secret</think> world');

    expect(result.visible).toBe('hello  world');
    expect(result.hasThinking).toBe(true);
    expect(result.thinkContent).toBe('secret');
  });

  it('strips unclosed think blocks from text', () => {
    const result = stripThinking('answer\n<think>still thinking');

    expect(result.visible).toBe('answer');
    expect(result.hasThinking).toBe(true);
    expect(result.thinkContent).toBe('still thinking');
  });

  it('parses streamed think tags split across chunks', () => {
    const visible: string[] = [];
    const parser = createThinkingStreamParser((text) => visible.push(text));

    parser.push('hello <thi');
    parser.push('nk>secret</th');
    parser.push('ink> world');
    const result = parser.finish();

    expect(visible.join('')).toBe('hello  world');
    expect(result.visible).toBe('hello  world');
    expect(result.thinkContent).toBe('secret');
    expect(getLastThinking()).toBe('secret');
  });

  it('remembers thinking while returning visible text', () => {
    const result = rememberThinkingFromText('<think>hidden</think>shown');

    expect(result.visible).toBe('shown');
    expect(getLastThinking()).toBe('hidden');
  });
});
