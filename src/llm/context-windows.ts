import type { ProviderId } from "../types.js";
import { modelCatalogFacts } from "./capabilities.js";

const CONTEXT_WINDOW_RULES: ReadonlyArray<{
  pattern: RegExp;
  tokens: number;
}> = [
  { pattern: /claude-(?:fable|mythos)-5/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-5/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-4\.[678]/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-4/i, tokens: 200_000 },
  { pattern: /claude-haiku-4/i, tokens: 200_000 },
  { pattern: /claude-3-7/i, tokens: 200_000 },
  { pattern: /claude-3-5/i, tokens: 200_000 },
  { pattern: /claude-3/i, tokens: 200_000 },
  { pattern: /gpt-5\.[456](?:[-.]|$)/i, tokens: 1_050_000 },
  { pattern: /gpt-5/i, tokens: 400_000 },
  { pattern: /gpt-4\.1/i, tokens: 1_047_576 },
  { pattern: /gpt-4o/i, tokens: 128_000 },
  { pattern: /gpt-4-turbo/i, tokens: 128_000 },
  { pattern: /gpt-4-32k/i, tokens: 32_768 },
  { pattern: /^gpt-4(?:-\d{4})?$/i, tokens: 8_192 },
  { pattern: /gpt-4/i, tokens: 128_000 },
  { pattern: /o3/i, tokens: 200_000 },
  { pattern: /o4/i, tokens: 200_000 },
  { pattern: /o1/i, tokens: 200_000 },
  { pattern: /gemini-3/i, tokens: 1_048_576 },
  { pattern: /gemini-2\.5/i, tokens: 1_048_576 },
  { pattern: /gemini-2\.0/i, tokens: 1_048_576 },
  { pattern: /gemini-1\.5/i, tokens: 1_048_576 },
  { pattern: /gemini/i, tokens: 128_000 },
  { pattern: /llama-4/i, tokens: 128_000 },
  { pattern: /llama-3\.3/i, tokens: 128_000 },
  { pattern: /llama-3\.1/i, tokens: 128_000 },
  { pattern: /llama-3/i, tokens: 128_000 },
  { pattern: /deepseek-v4/i, tokens: 1_000_000 },
  { pattern: /deepseek/i, tokens: 128_000 },
  { pattern: /qwen3\.7/i, tokens: 1_000_000 },
  { pattern: /qwen3\.(?:8|6|5)/i, tokens: 262_144 },
  { pattern: /qwen3/i, tokens: 128_000 },
  { pattern: /qwen2\.5/i, tokens: 128_000 },
  { pattern: /qwen/i, tokens: 128_000 },
  { pattern: /kimi-k3/i, tokens: 1_000_000 },
  { pattern: /kimi-k2/i, tokens: 256_000 },
  { pattern: /kimi/i, tokens: 128_000 },
  { pattern: /glm-?5\.2/i, tokens: 1_000_000 },
  { pattern: /glm-?5/i, tokens: 200_000 },
  { pattern: /glm-?4\.[56]/i, tokens: 200_000 },
  { pattern: /glm-?4/i, tokens: 128_000 },
  { pattern: /minimax-m3/i, tokens: 1_000_000 },
  { pattern: /minimax-m2\.7/i, tokens: 204_800 },
  { pattern: /minimax/i, tokens: 128_000 },
  { pattern: /mimo/i, tokens: 128_000 },
  { pattern: /gpt-oss/i, tokens: 128_000 },
  { pattern: /nemotron/i, tokens: 128_000 },
  { pattern: /muse-spark/i, tokens: 1_048_576 },
];

const DEFAULT_CONTEXT_WINDOW = 250_000;

const PROVIDER_CONTEXT_OVERRIDES: Partial<
  Record<ProviderId, ReadonlyArray<{ pattern: RegExp; tokens: number }>>
> = {
  tokenrouter: [
    { pattern: /^(?:[a-z0-9-]+\/)?deepseek-v4-(?:pro|flash)$/i, tokens: 1_000_000 },
    { pattern: /^(?:[a-z0-9-]+\/)?minimax-m3$/i, tokens: 524_288 },
    { pattern: /^(?:[a-z0-9-]+\/)?minimax-m2p7$/i, tokens: 196_608 },
    { pattern: /^(?:[a-z0-9-]+\/)?kimi-k2(?:p\d|\.\d)/i, tokens: 262_144 },
    { pattern: /^(?:[a-z0-9-]+\/)?qwen3p\d-plus$/i, tokens: 262_144 },
    { pattern: /^(?:[a-z0-9-]+\/)?glm-5p1(?:-fast)?$/i, tokens: 202_752 },
    { pattern: /^(?:[a-z0-9-]+\/)?gpt-oss-120b$/i, tokens: 131_072 },
  ],
};

export function modelContextWindow(
  model: string | undefined,
  provider?: ProviderId | undefined,
): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const overrides = provider ? PROVIDER_CONTEXT_OVERRIDES[provider] : undefined;
  if (overrides) {
    for (const rule of overrides) {
      if (rule.pattern.test(model)) return rule.tokens;
    }
  }
  const published = provider
    ? modelCatalogFacts(provider, model)?.contextTokens
    : undefined;
  if (published !== undefined) return published;
  return nominalModelContextWindow(model);
}

export function modelMaxOutputTokens(
  provider: ProviderId | string | undefined,
  model: string | undefined,
  profileOutputTokens?: number | undefined,
): number | undefined {
  if (!provider || !model) return profileOutputTokens;
  return modelCatalogFacts(provider, model)?.maxOutputTokens ?? profileOutputTokens;
}

export function nominalModelContextWindow(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (rule.pattern.test(model)) return rule.tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function providerContextOverrideTokens(
  provider: ProviderId,
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  const overrides = PROVIDER_CONTEXT_OVERRIDES[provider];
  if (!overrides) return undefined;
  return overrides.find((rule) => rule.pattern.test(model))?.tokens;
}

const PROVIDER_INPUT_TOKEN_BUDGETS: Partial<
  Record<ProviderId, ReadonlyArray<{ pattern: RegExp; tokens: number }>>
> = {};

export function providerInputTokenBudget(
  provider: ProviderId,
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  const budgets = PROVIDER_INPUT_TOKEN_BUDGETS[provider];
  if (!budgets) return undefined;
  return budgets.find((rule) => rule.pattern.test(model))?.tokens;
}
