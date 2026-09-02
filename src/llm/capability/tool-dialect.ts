import { getConfig } from "../../store/config.js";
import type { ProviderId } from "../../types.js";
import { isTextOnlyModel } from "../tool-protocol.js";
import type { ToolCallingMode, ToolDialect } from "../tool-protocol.js";

const providerToolDialect: Record<ProviderId, ToolDialect> = {
  free: "openai",
  openai: "openai",
  openrouter: "openai",
  nvidia: "openai",
  agentrouter: "openai",
  bynara: "openai",
  "qwen-cloud": "openai",
  modal: "openai",
  lightning: "openai",
  tokenrouter: "openai",
  meta: "openai",
  fireworks: "openai",
  hetzner: "openai",
  orcarouter: "openai",
  "merge-gateway": "openai",
  anthropic: "anthropic",
  "aws-mantle": "openai",
  gemini: "gemini",
  ollama: "ollama",
};

const nativeToolsDenylist: RegExp[] = [
  /embed/i,
  /embedding/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /moderation/i,
  /text-embedding/i,
];

const ollamaToolFamilies: RegExp[] = [
  /llama3\.1/i,
  /llama3\.2/i,
  /llama3\.3/i,
  /llama-?4/i,
  /qwen/i,
  /mistral/i,
  /command-r/i,
  /firefunction/i,
  /tool/i,
  /nemotron/i,
  /deepseek/i,
  /gpt-oss/i,
  /gemma3/i,
];

function isAwsMantleAnthropicModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}

function customToolCapability(
  provider: ProviderId,
): "supported" | "unsupported" | "unknown" {
  const def = (getConfig().customProviders ?? []).find(
    (definition) => definition.id === provider,
  );
  return def?.profile?.tools ?? "unknown";
}

export function resolveToolDialect(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): ToolDialect {
  const mode = toolCalling ?? getConfig().toolCalling ?? "auto";
  if (mode === "text") return "none";
  if (isTextOnlyModel(provider, model)) return "none";
  if (nativeToolsDenylist.some((re) => re.test(model))) return "none";

  if (provider === "aws-mantle") {
    return isAwsMantleAnthropicModel(model) ? "anthropic" : "openai";
  }

  if (provider === "ollama") {
    if (mode === "native") return "ollama";
    if (ollamaToolFamilies.some((re) => re.test(model))) return "ollama";
    return "none";
  }

  if (providerToolDialect[provider] === undefined) {
    return customToolCapability(provider) === "supported" ? "openai" : "none";
  }

  return providerToolDialect[provider] ?? "none";
}
