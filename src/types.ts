export const providerIds = ['groq', 'gemini', 'openrouter', 'openai', 'anthropic', 'ollama'] as const;

export type ProviderId = (typeof providerIds)[number];
export type Mode = 'ask' | 'agent';
export type RiskLevel = 'safe' | 'confirm' | 'block';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CompletionRequest {
  provider?: ProviderId;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
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
  source: 'env' | 'keychain' | 'fallback' | 'local' | 'missing';
  maskedKey?: string;
  model: string;
  note?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number;
}
