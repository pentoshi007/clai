import type {
  ChatMessage,
  CompletionRequest,
  ProviderId,
  ReasoningPreference,
  ToolCallStreamDelta,
  ToolDefinition,
} from "../../../types.js";

export interface StreamRequestInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly allowModelFallback: boolean;
  readonly preferModelFallback: boolean;
  readonly maxTokens: number | undefined;
  readonly signal: AbortSignal | undefined;
  readonly thinking: ReasoningPreference | undefined;
  readonly retryWithoutThinking: boolean;
  readonly toolsAttached: boolean;
  readonly tools: ToolDefinition[] | undefined;
  readonly onToolCallDelta: (delta: ToolCallStreamDelta) => void;
}

export const buildStreamRequest = (
  input: StreamRequestInput,
): CompletionRequest => ({
  provider: input.provider,
  model: input.model,
  allowModelFallback: input.allowModelFallback,
  preferModelFallback: input.preferModelFallback,
  messages: input.messages,
  maxTokens: input.maxTokens,
  signal: input.signal,
  thinking:
    input.retryWithoutThinking && input.thinking
      ? { ...input.thinking, enabled: false, effort: "low" as const }
      : input.thinking,
  ...(input.toolsAttached
    ? {
        tools: input.tools,
        toolChoice: "auto" as const,
        parallelToolCalls: true,
        onToolCallDelta: input.onToolCallDelta,
      }
    : {}),
});
