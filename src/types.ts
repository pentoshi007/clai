export const providerIds = [
  "groq",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "nvidia",
  "agentrouter",
  "kimchi",
  "aws-mantle",
  "ollama",
  "bynara",
  "qwen-cloud",
] as const;

export type ProviderId = (typeof providerIds)[number];
export type Mode = "ask" | "agent";
export type RiskLevel = "safe" | "confirm" | "block";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ReasoningPreference {
  enabled: boolean;
  effort: ReasoningEffort;
}

export interface ChatImage {
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  /** Original path, for display/debugging. */
  path?: string | undefined;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Optional image attachments for this message. Only populated for user
   * turns when the active model supports vision; providers that understand
   * images serialize these into their multimodal message format, and
   * providers/models without vision ignore them (the text content still
   * carries a note so the agent can fall back to OCR tools).
   */
  images?: ChatImage[] | undefined;
}

export interface CompletionRequest {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  /**
   * Permit the configured provider chain to use each fallback provider's
   * default model when the explicitly selected model cannot produce a usable
   * completion. Agent turns opt in so a reasoning-only stream never ends the
   * user's turn without an answer.
   */
  allowModelFallback?: boolean | undefined;
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

export interface ToolStats {
  bytesRead: number;
  bytesDropped: number;
  linesRead: number;
  elapsedMs: number;
  captureLimitHit?: boolean | undefined;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  outputPath?: string | undefined;
  truncated?: boolean | undefined;
  stats?: ToolStats | undefined;
}
