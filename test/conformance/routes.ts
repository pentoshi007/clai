import type { ProviderId } from "../../src/types.js";
import type { WireFamily } from "./wire-fixtures.js";

export interface ConformanceRoute {
  readonly id: string;
  readonly provider: ProviderId;
  readonly family: WireFamily;
  readonly model: string;
  readonly auth: { apiKey?: string; baseUrl?: string };
  readonly urlContains: string;
  readonly streamUrlContains?: string;
  readonly note?: string;
}

const FAKE_BASE = "https://conformance.invalid/v1";

export const CONFORMANCE_ROUTES: readonly ConformanceRoute[] = [
  {
    id: "free",
    provider: "free",
    family: "chat_completions",
    model: "free-1/deepseek-v4-flash-free",
    auth: {},
    urlContains: "/chat/completions",
    note: "keyless free-tier gateway",
  },
  {
    id: "openai",
    provider: "openai",
    family: "chat_completions",
    model: "gpt-5.4-mini",
    auth: { apiKey: "sk-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "openrouter",
    provider: "openrouter",
    family: "chat_completions",
    model: "deepseek/deepseek-v4-pro",
    auth: { apiKey: "sk-or-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "nvidia",
    provider: "nvidia",
    family: "chat_completions",
    model: "openai/gpt-oss-20b",
    auth: { apiKey: "nvapi-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "agentrouter",
    provider: "agentrouter",
    family: "chat_completions",
    model: "claude-opus-4-6",
    auth: { apiKey: "sk-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "bynara",
    provider: "bynara",
    family: "chat_completions",
    model: "mimo-v2.5-free",
    auth: { apiKey: "conformance-key" },
    urlContains: "/chat/completions",
  },
  {
    id: "qwen-cloud",
    provider: "qwen-cloud",
    family: "chat_completions",
    model: "qwen3.7-plus",
    auth: { apiKey: "sk-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "modal",
    provider: "modal",
    family: "chat_completions",
    model: "moonshotai/Kimi-K3",
    auth: { apiKey: "wk-conformance:ws-conformance", baseUrl: FAKE_BASE },
    urlContains: "/chat/completions",
    note: "user deployment endpoint plus proxy-token headers",
  },
  {
    id: "lightning",
    provider: "lightning",
    family: "chat_completions",
    model: "openai/gpt-5",
    auth: { apiKey: "conformance-key" },
    urlContains: "/chat/completions",
  },
  {
    id: "tokenrouter",
    provider: "tokenrouter",
    family: "chat_completions",
    model: "moonshotai/kimi-k3",
    auth: { apiKey: "sk-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "fireworks",
    provider: "fireworks",
    family: "chat_completions",
    model: "accounts/fireworks/models/kimi-k2p6",
    auth: { apiKey: "fw_conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "hetzner",
    provider: "hetzner",
    family: "chat_completions",
    model: "Qwen/Qwen3.6-35B-A3B-FP8",
    auth: { apiKey: "conformance-key" },
    urlContains: "/chat/completions",
  },
  {
    id: "orcarouter",
    provider: "orcarouter",
    family: "chat_completions",
    model: "openai/gpt-4o-mini",
    auth: { apiKey: "sk-orca-conformance" },
    urlContains: "/chat/completions",
  },
  {
    id: "aws-mantle-compatible",
    provider: "aws-mantle",
    family: "chat_completions",
    model: "meta.llama3-70b",
    auth: { apiKey: "conformance-key" },
    urlContains: "/chat/completions",
    note: "non-Claude models take the compatible wire",
  },
  {
    id: "anthropic",
    provider: "anthropic",
    family: "anthropic_messages",
    model: "claude-3-5-haiku-latest",
    auth: { apiKey: "sk-ant-conformance" },
    urlContains: "/messages",
  },
  {
    id: "aws-mantle-anthropic",
    provider: "aws-mantle",
    family: "anthropic_messages",
    model: "anthropic.claude-haiku-4-5",
    auth: { apiKey: "conformance-key" },
    urlContains: "/messages",
  },
  {
    id: "gemini",
    provider: "gemini",
    family: "gemini_generate_content",
    model: "gemini-3.5-flash",
    auth: { apiKey: "AIzaConformanceKey0000" },
    urlContains: ":generateContent",
    streamUrlContains: ":streamGenerateContent",
  },
  {
    id: "meta",
    provider: "meta",
    family: "meta_responses",
    model: "muse-spark-1.2",
    auth: { apiKey: "conformance-key" },
    urlContains: "/responses",
  },
  {
    id: "ollama",
    provider: "ollama",
    family: "ollama_chat",
    model: "llama3.1:8b",
    auth: { baseUrl: "http://127.0.0.1:11434" },
    urlContains: "/api/chat",
  },
];
