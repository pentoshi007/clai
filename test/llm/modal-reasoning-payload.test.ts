import { beforeEach, describe, expect, it } from 'vitest';
import { buildChatBody, ingestOpenAiModelCatalog } from '../../src/llm/http.js';
import { resetReasoningKnowledge } from '../../src/llm/capabilities.js';
import type { ReasoningEffort } from '../../src/types.js';

const MODEL = 'moonshotai/Kimi-K3';

function knobs(
  enabled: boolean,
  effort: ReasoningEffort,
  model = MODEL,
): Record<string, unknown> {
  const body = JSON.parse(
    buildChatBody({
      model,
      providerId: 'modal',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      reasoning: { enabled, effort },
      reasoningStyle: 'modal',
    }),
  ) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ['reasoning_effort', 'reasoning', 'chat_template_kwargs']) {
    if (body[key] !== undefined) picked[key] = body[key];
  }
  return picked;
}

function ingestKimiCatalog(): void {
  ingestOpenAiModelCatalog('modal', {
    data: [
      {
        id: MODEL,
        supported_features: ['tools', 'reasoning'],
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
    ],
  });
}

describe('modal reasoning payload', () => {
  beforeEach(() => {
    resetReasoningKnowledge();
  });

  it('never sends the boolean reasoning object the endpoint ignores', () => {
    ingestKimiCatalog();
    for (const effort of ['low', 'medium', 'high', 'max'] as ReasoningEffort[]) {
      expect(knobs(true, effort).reasoning).toBeUndefined();
    }
    expect(knobs(false, 'medium').reasoning).toBeUndefined();
  });

  it('disables reasoning with the explicit none sentinel', () => {
    ingestKimiCatalog();
    expect(knobs(false, 'medium')).toEqual({ reasoning_effort: 'none' });
    expect(knobs(true, 'none')).toEqual({ reasoning_effort: 'none' });
  });

  it('clamps requested effort to the values the catalog advertises', () => {
    ingestKimiCatalog();
    expect(knobs(true, 'minimal')).toEqual({ reasoning_effort: 'low' });
    expect(knobs(true, 'low')).toEqual({ reasoning_effort: 'low' });
    expect(knobs(true, 'medium')).toEqual({ reasoning_effort: 'high' });
    expect(knobs(true, 'high')).toEqual({ reasoning_effort: 'high' });
    expect(knobs(true, 'xhigh')).toEqual({ reasoning_effort: 'max' });
    expect(knobs(true, 'max')).toEqual({ reasoning_effort: 'max' });
  });

  it('honours a catalog that does advertise medium', () => {
    ingestOpenAiModelCatalog('modal', {
      data: [
        {
          id: MODEL,
          supported_features: ['reasoning'],
          reasoning_options: [
            { type: 'effort', values: ['low', 'medium', 'high'] },
          ],
        },
      ],
    });
    expect(knobs(true, 'medium')).toEqual({ reasoning_effort: 'medium' });
    expect(knobs(true, 'max')).toEqual({ reasoning_effort: 'high' });
  });

  it('sends no reasoning knob to a modal model that cannot reason', () => {
    ingestOpenAiModelCatalog('modal', {
      data: [{ id: 'meta-llama/Llama-4', supported_features: ['tools'] }],
    });
    expect(knobs(true, 'high', 'meta-llama/Llama-4')).toEqual({});
    expect(knobs(false, 'medium', 'meta-llama/Llama-4')).toEqual({});
  });

  it('falls back to the documented ladder when the catalog is unknown', () => {
    expect(knobs(true, 'medium')).toEqual({ reasoning_effort: 'high' });
    expect(knobs(true, 'low')).toEqual({ reasoning_effort: 'low' });
    expect(knobs(false, 'medium')).toEqual({ reasoning_effort: 'none' });
  });
});
