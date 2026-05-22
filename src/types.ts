export const providerIds = [
  "groq",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "nvidia",
  "ollama",
] as const;

export type ProviderId = (typeof providerIds)[number];
export type Mode = "ask" | "agent";
export type RiskLevel = "safe" | "confirm" | "block";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ReasoningPreference {
  enabled: boolean;
  effort: ReasoningEffort;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface CompletionRequest {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  thinking?: ReasoningPreference | undefined;
}

export interface CompletionResult {
  text: string;
  provider: ProviderId;
  model: string;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  active: boolean;
  configured: boolean;
  source: "env" | "keychain" | "fallback" | "local" | "missing";
  maskedKey?: string | undefined;
  model: string;
  note?: string | undefined;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  outputPath?: string | undefined;
  truncated?: boolean | undefined;
}
