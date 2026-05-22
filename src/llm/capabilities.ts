import type { ProviderId } from "../types.js";

// Patterns of model names that support an explicit reasoning/thinking
// toggle. The match is case-insensitive substring or regex.
const reasoningPatterns: Record<ProviderId, RegExp[]> = {
  groq: [
    /deepseek-r1/i,
    /qwen3/i,
    /gpt-oss/i,
    /kimi-k2/i,
  ],
  gemini: [
    /gemini-2\.5/i,
    /gemini-3/i,
    /gemini-3\.5/i,
  ],
  openrouter: [
    /:thinking/i,
    /deepseek-r1/i,
    /qwen3/i,
    /kimi-k2/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /gpt-5/i,
    /o[134]/i,
    /grok.*reasoner/i,
  ],
  openai: [
    /gpt-5/i,
    /o1/i,
    /o3/i,
    /o4/i,
  ],
  anthropic: [
    /claude-(?:opus|sonnet|haiku)-(?:3-7|4|4-\d)/i,
    /claude-3-7/i,
  ],
  nvidia: [
    /kimi-k2/i,
    /deepseek-r1/i,
    /deepseek-v[34]/i,
    /qwen3/i,
    /nemotron/i,
    /glm-?5/i,
    /minimax-m2/i,
    /gpt-oss/i,
  ],
  ollama: [
    /deepseek-r1/i,
    /qwen3/i,
    /qwq/i,
  ],
};

export function modelSupportsThinking(provider: ProviderId, model: string): boolean {
  const patterns = reasoningPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model));
}
