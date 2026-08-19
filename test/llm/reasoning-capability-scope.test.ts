import { beforeEach, describe, expect, it } from 'vitest';
import {
  learnModelEmitsReasoning,
  markReasoningUnsupported,
  modelReasoningEfforts,
  modelReasoningEvidence,
  modelSupportsThinking,
  registerModelCatalog,
  resetReasoningKnowledge,
} from '../../src/llm/capabilities.js';
import { ingestOpenAiModelCatalog } from '../../src/llm/http.js';

describe('reasoning capability knowledge', () => {
  beforeEach(() => {
    resetReasoningKnowledge();
  });

  it('keeps a per-provider verdict from leaking to the same model elsewhere', () => {
    markReasoningUnsupported('bynara', 'grok-4.5-free');
    registerModelCatalog('bynara', [{ id: 'grok-4.5-free', reasoning: false }]);

    expect(modelSupportsThinking('bynara', 'grok-4.5-free')).toBe(false);
    expect(modelSupportsThinking('openrouter', 'x-ai/grok-4.5-reasoner')).toBe(
      true,
    );
    expect(modelReasoningEvidence('openrouter', 'x-ai/grok-4.5-reasoner')).toBe(
      'pattern',
    );
  });

  it('lets the live catalog enable a model the name patterns do not know', () => {
    expect(modelSupportsThinking('bynara', 'laguna-s-2.1')).toBe(false);

    registerModelCatalog('bynara', [{ id: 'laguna-s-2.1', reasoning: true }]);

    expect(modelSupportsThinking('bynara', 'laguna-s-2.1')).toBe(true);
    expect(modelReasoningEvidence('bynara', 'laguna-s-2.1')).toBe('catalog');
  });

  it('lets the live catalog disable a model the name patterns match', () => {
    expect(modelSupportsThinking('bynara', 'kimi-k3-free')).toBe(true);

    registerModelCatalog('bynara', [{ id: 'kimi-k3-free', reasoning: false }]);

    expect(modelSupportsThinking('bynara', 'kimi-k3-free')).toBe(false);
  });

  it('promotes a model to supported once it actually emits reasoning', () => {
    expect(modelSupportsThinking('bynara', 'mimo-v2.5-free')).toBe(false);

    learnModelEmitsReasoning('bynara', 'mimo-v2.5-free');

    expect(modelSupportsThinking('bynara', 'mimo-v2.5-free')).toBe(true);
    expect(modelReasoningEvidence('bynara', 'mimo-v2.5-free')).toBe('observed');
    expect(modelSupportsThinking('tokenrouter', 'mimo-v2.5-free')).toBe(false);
  });

  it('keeps a rejected knob off even when the model reasons by default', () => {
    learnModelEmitsReasoning('bynara', 'stepfun-3.7-flash');
    markReasoningUnsupported('bynara', 'stepfun-3.7-flash');

    expect(modelSupportsThinking('bynara', 'stepfun-3.7-flash')).toBe(false);
    expect(modelReasoningEvidence('bynara', 'stepfun-3.7-flash')).toBe(
      'rejected',
    );
  });

  it('forgets every runtime verdict on reset so each run relearns', () => {
    markReasoningUnsupported('bynara', 'kimi-k3-free');
    learnModelEmitsReasoning('bynara', 'mimo-v2.5-free');
    registerModelCatalog('bynara', [{ id: 'laguna-s-2.1', reasoning: true }]);

    resetReasoningKnowledge();

    expect(modelReasoningEvidence('bynara', 'mimo-v2.5-free')).toBe('unknown');
    expect(modelReasoningEvidence('bynara', 'laguna-s-2.1')).toBe('unknown');
    expect(modelSupportsThinking('bynara', 'kimi-k3-free')).toBe(true);
  });

  it('reads reasoning support and effort values out of an OpenAI-shaped catalog', () => {
    ingestOpenAiModelCatalog('modal', {
      data: [
        {
          id: 'moonshotai/Kimi-K3',
          supported_features: ['tools', 'json_mode', 'reasoning'],
          reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        },
        { id: 'plain/model', supported_features: ['tools'] },
      ],
    });

    expect(modelSupportsThinking('modal', 'moonshotai/Kimi-K3')).toBe(true);
    expect(modelReasoningEfforts('modal', 'moonshotai/Kimi-K3')).toEqual([
      'low',
      'high',
      'max',
    ]);
    expect(modelSupportsThinking('modal', 'plain/model')).toBe(false);
  });

  it('treats a missing reasoning field as unknown rather than false', () => {
    ingestOpenAiModelCatalog('bynara', {
      data: [{ id: 'kimi-k3-free', context_window: 1000000 }],
    });

    expect(modelReasoningEvidence('bynara', 'kimi-k3-free')).toBe('pattern');
    expect(modelSupportsThinking('bynara', 'kimi-k3-free')).toBe(true);
  });
});
