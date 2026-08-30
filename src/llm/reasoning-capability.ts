import type { ProviderId } from "../types.js";
import { FAMILYLESS_ENDPOINT_LAYERS } from "./provider-profile-layers.js";

// Patterns of model names that support an explicit reasoning/thinking
// toggle. The match is case-insensitive substring or regex.
export const REASONING_PATTERNS: Record<ProviderId, RegExp[]> = {
  free: [/deepseek/i, /kimi/i, /minimax/i, /mimo/i, /nemotron/i],
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
  "aws-mantle": [/claude-(?:opus|sonnet|haiku)-4/i],
  bynara: [/kimi/i, /deepseek/i, /agnes/i, /stepfun/i],
  "qwen-cloud": [/qwen3/i, /qwen2/i],
  // Modal Endpoints serve the open-weight catalog (Kimi, Qwen, DeepSeek, GLM,
  // Gemma, GPT-OSS, Nemotron); the thinking families among them are matched by
  // their repo id, which is also the model name on the wire.
  modal: [
    /kimi/i,
    /qwen3/i,
    /deepseek/i,
    /glm-?[45]/i,
    /gpt-oss/i,
    /nemotron/i,
    /gemma-?[34]/i,
  ],
  // Lightning AI proxies vendor models under namespaced ids (openai/gpt-5,
  // anthropic/claude-opus-4-8, google/gemini-3.5-flash, lightning-ai/...).
  lightning: [
    /gpt-5/i,
    /o[134](?:-mini)?\b/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /claude-fable/i,
    /gemini-3/i,
    /gemini-2\.5/i,
    /deepseek/i,
    /gpt-oss/i,
    /nemotron/i,
  ],
  // TokenRouter documents reasoning support for every model it serves.
  tokenrouter: [
    /kimi/i,
    /deepseek/i,
    /qwen3/i,
    /glm-?5/i,
    /gpt-oss/i,
    /minimax/i,
  ],
  meta: [/muse-spark/i],
  fireworks: [/kimi/i, /deepseek/i, /qwen3/i, /glm-?5/i, /gpt-oss/i, /nemotron/i, /minimax/i, /mimo/i],
  hetzner: [/qwen3/i, /qwen/i],
  // OrcaRouter exposes one unified reasoning_effort knob across every routed
  // upstream; match the reasoning families its catalog publishes.
  orcarouter: [
    /o[134]/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet)/i,
    /gemini-2\.5|gemini-3/i,
    /deepseek-reasoner/i,
    /grok.*reason/i,
    /qwen3/i,
    /kimi/i,
    /glm/i,
  ],
  // Merge Gateway normalizes one `reasoning_effort` knob across its whole
  // catalog and clamps it per route (it answers with a
  // `reasoning_effort_adjusted` warning instead of failing). Verified live on
  // /v1/openai/chat/completions: glm, minimax, kimi, grok-reasoning, gpt-oss,
  // dola-seed, mimo, inkling, nova, deepseek-v4 and qwen3.x all return chain of
  // thought; OpenAI/Anthropic/Gemini accept the knob but keep the text hidden.
  "merge-gateway": [
    /o[134]/i,
    /gpt-5/i,
    /gpt-oss/i,
    /claude-(?:opus|sonnet|haiku)/i,
    /gemini-2\.5|gemini-3/i,
    /deepseek-(?:r1|v[34]|reasoner)/i,
    /qwen3/i,
    /glm-?[45]/i,
    /kimi/i,
    /minimax/i,
    /mimo/i,
    /nemotron/i,
    /nova/i,
    /dola-seed/i,
    /inkling/i,
    /magistral/i,
    /thinking/i,
    /grok-.*reasoning|grok-4\.[3-9]|grok-[5-9]/i,
  ],
};

export function endpointAcceptedEfforts(
  provider: ProviderId,
): readonly string[] | undefined {
  const efforts =
    FAMILYLESS_ENDPOINT_LAYERS[provider]?.reasoning?.acceptedEfforts;
  return efforts && efforts.length > 0 ? efforts : undefined;
}
