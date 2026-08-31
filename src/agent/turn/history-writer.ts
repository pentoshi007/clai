import type { ChatImage, ChatMessage, CompletionResult } from "../../types.js";
import {
  stripSentinelTokens,
  textBeforeToolCall,
} from "../tool-call-parser.js";
import { hasReasoningMarker } from "../../llm/reasoning-marker.js";
import { stripThinking } from "../../ui/thinking.js";
import {
  legacyReasoningBlockFromArtifacts,
  reasoningArtifactsForPersistence,
} from "../../llm/reasoning-artifacts.js";

export const ACTION_CYCLE_RECOVERY_PREFIX = "[ACTION CYCLE RECOVERY] ";

export interface TurnHistoryPorts {
  readonly messages: ChatMessage[];
  readonly images: readonly ChatImage[] | undefined;
  readonly sanitizeAssistantText: (text: string) => string;
  readonly visibleCommitted: () => boolean;
  readonly writeAssistantMessage: (text: string) => void;
}

export interface TurnHistoryWriter {
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly upsertActionCycleRecovery: (content: string) => void;
  readonly recoveryProse: (content: string) => string | undefined;
  readonly pushAssistantHistory: (
    content: string,
    reasoning?: Pick<CompletionResult, "reasoningArtifacts" | "reasoningBlock">,
  ) => void;
}

type ReasoningInput =
  | Pick<CompletionResult, "reasoningArtifacts" | "reasoningBlock">
  | undefined;

const looksLikeToolPayload = (text: string): boolean =>
  /^```|^\{|<tool_call>|<\|tool_call(?:s_section)?_begin\|>/i.test(text) ||
  /\n\s*\{[\s\S]*\}\s*$/.test(text);

export const recoveryProseFrom = (content: string): string | undefined => {
  const text = textBeforeToolCall(stripSentinelTokens(content)).trim();
  if (!text || looksLikeToolPayload(text)) return undefined;
  return text;
};

const buildRecoveryUserMessage = (
  ports: TurnHistoryPorts,
  content: string,
): ChatMessage => {
  const message: ChatMessage = { role: "user", content, internal: true };
  if (ports.images && ports.images.length > 0) {
    message.images = [...ports.images];
  }
  return message;
};

const replaceActionCycleRecovery = (
  ports: TurnHistoryPorts,
  content: string,
): void => {
  const prefix = ACTION_CYCLE_RECOVERY_PREFIX;
  for (let index = ports.messages.length - 1; index >= 0; index -= 1) {
    const message = ports.messages[index]!;
    if (
      message.role === "user" &&
      message.internal &&
      message.content.startsWith(prefix)
    ) {
      ports.messages.splice(index, 1);
      break;
    }
  }
  ports.messages.push(buildRecoveryUserMessage(ports, prefix + content));
};

const persistedReasoning = (
  reasoning: ReasoningInput,
): Pick<ChatMessage, "reasoningBlock" | "reasoningArtifacts"> => {
  const persistedArtifacts = reasoningArtifactsForPersistence({
    artifacts: reasoning?.reasoningArtifacts,
    hasToolCalls: false,
  });
  const reasoningBlock = persistedArtifacts
    ? legacyReasoningBlockFromArtifacts(persistedArtifacts)
    : reasoning?.reasoningArtifacts
      ? undefined
      : reasoning?.reasoningBlock;
  return {
    ...(reasoningBlock?.text || reasoningBlock?.items?.length
      ? { reasoningBlock }
      : {}),
    ...(persistedArtifacts ? { reasoningArtifacts: persistedArtifacts } : {}),
  };
};

const appendAssistantHistory = (
  ports: TurnHistoryPorts,
  content: string,
  reasoning: ReasoningInput,
): void => {
  const cleaned = ports.sanitizeAssistantText(
    hasReasoningMarker(content) ? stripThinking(content).visible : content,
  );
  if (!ports.visibleCommitted()) {
    const prose = recoveryProseFrom(cleaned);
    if (prose) ports.writeAssistantMessage(prose);
  }
  ports.messages.push({
    role: "assistant",
    content: cleaned.trim()
      ? cleaned
      : "[No visible assistant response was produced.]",
    ...persistedReasoning(reasoning),
  });
};

export const createTurnHistoryWriter = (
  ports: TurnHistoryPorts,
): TurnHistoryWriter => ({
  recoveryUserMessage: (content) => buildRecoveryUserMessage(ports, content),
  upsertActionCycleRecovery: (content) =>
    replaceActionCycleRecovery(ports, content),
  recoveryProse: recoveryProseFrom,
  pushAssistantHistory: (content, reasoning) =>
    appendAssistantHistory(ports, content, reasoning),
});
