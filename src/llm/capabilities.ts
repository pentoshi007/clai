import type { ProviderId } from "../types.js";

// Patterns of model names that support an explicit reasoning/thinking
// toggle. The match is case-insensitive substring or regex.
const reasoningPatterns: Record<ProviderId, RegExp[]> = {
  groq: [/qwen\/qwen3-32b/i, /gpt-oss/i],
  gemini: [/gemini-2\.5/i, /gemini-3/i, /gemini-3\.5/i],
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
  openai: [/gpt-5/i, /o1/i, /o3/i, /o4/i],
  anthropic: [/claude-(?:opus|sonnet|haiku)-(?:3-7|4|4-\d)/i, /claude-3-7/i],
  nvidia: [
    /kimi-k2/i,
    /deepseek-r1/i,
    /deepseek-v[34]/i,
    /qwen3/i,
    /nemotron/i,
    /glm-?5/i,
    /gpt-oss/i,
  ],
  ollama: [/deepseek-r1/i, /qwen3/i, /qwq/i],
  agentrouter: [
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /deepseek-(?:v[34]|r1)/i,
    /glm-?[45]/i,
    /qwen3/i,
    /kimi-k2/i,
    /o[134]/i,
  ],
  kimchi: [/kimi-k2/i, /minimax-m2/i, /nemotron-3-super/i],
  "aws-mantle": [/claude-(?:opus|sonnet|haiku)-4/i],
};

export function modelSupportsThinking(
  provider: ProviderId,
  model: string,
): boolean {
  const patterns = reasoningPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model));
}

// Patterns of model names that accept image input (multimodal vision).
// Used to decide whether to send actual image bytes to the model (like
// Claude Code) versus falling back to a text note + OCR tools.
const visionPatterns: Record<ProviderId, RegExp[]> = {
  groq: [
    // Llama 4 (scout/maverick) and llama-3.2 vision models on Groq.
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /meta-llama\/llama-4/i,
  ],
  gemini: [
    // All current Gemini models are natively multimodal.
    /gemini-/i,
  ],
  openrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /grok-(?:2-)?vision/i,
    /grok-4/i,
    /:vision/i,
  ],
  openai: [/gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /o[34]/i, /gpt-4-turbo/i],
  anthropic: [
    // Claude 3+ (opus/sonnet/haiku) are all vision-capable.
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
  ],
  nvidia: [
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /vila/i,
    /neva/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /gemma-3/i,
    /minimax-m3/i,
  ],
  ollama: [
    /llava/i,
    /llama3\.2-vision/i,
    /llama-?4/i,
    /bakllava/i,
    /moondream/i,
    /minicpm-?v/i,
    /qwen2?\.?5?-vl/i,
    /gemma3/i,
  ],
  agentrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /qwen2?\.?5?-vl/i,
    /glm-4\.?\d*v/i,
  ],
  kimchi: [/kimi-k2/i, /minimax-m2/i, /nemotron-3-super/i],
  "aws-mantle": [/claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i],
};

/**
 * Whether the given provider/model can accept image input. When true, the
 * agent attaches real image bytes to the user message; when false, it falls
 * back to a text note and OCR/inspection tools.
 */
export function modelSupportsVision(
  provider: ProviderId,
  model: string,
): boolean {
  const patterns = visionPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model));
}

// Fast same-provider fallback for image prompts when the user's selected
// model is text-only. This keeps drag-and-drop images working like Claude
// Code/Codex without changing the user's configured default model.
const preferredVisionModels: Partial<Record<ProviderId, string>> = {
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  gemini: "gemini-3.5-flash",
  openrouter: "google/gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "meta/llama-4-maverick-17b-128e-instruct",
  agentrouter: "claude-opus-4-6",
  kimchi: "kimi-k2.6",
  "aws-mantle": "anthropic.claude-haiku-4-5",
  ollama: "llama3.2-vision",
};

/**
 * Return a same-provider vision model to use for an image request. If the
 * current model already supports vision, it is returned unchanged. If the
 * provider has no known vision fallback, returns undefined so callers can
 * fall back to OCR/text notes.
 */
export function preferredVisionModel(
  provider: ProviderId,
  currentModel: string,
): string | undefined {
  if (modelSupportsVision(provider, currentModel)) return currentModel;
  const fallback = preferredVisionModels[provider];
  if (!fallback) return undefined;
  return modelSupportsVision(provider, fallback) ? fallback : undefined;
}
