import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
  ToolDefinition,
} from "../../types.js";
import {
  reasoningArtifactSignature,
  reasoningArtifactText,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "../reasoning-artifacts.js";
import { wireToolArguments } from "../tool-wire/argument-repair.js";
import {
  mapToolChoiceToOpenAi,
  toWireName,
  type ToolChoice,
} from "../tool-protocol.js";
import {
  invalidNativeToolHistoryIndexes,
  portableToolCallContent,
  portableToolResultContent,
} from "./tool-history.js";
import "../../tools/definitions.js";

export function toOpenAiTools(defs: ToolDefinition[]): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}> {
  return defs.map((d) => ({
    type: "function" as const,
    function: {
      name: d.wireName,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

export type OpenAiWireMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | unknown[] | null;
      reasoning_content?: string;
      reasoning_details?: unknown;
      extra_content?: { google?: { thought_signature: string } };
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
      name?: string;
    };

interface CompatibleReasoningReplayOptions {
  readonly target: ReasoningArtifactReplayTarget;
  readonly observe?: ReasoningArtifactReplayObserver | undefined;
  readonly forceScope?: boolean | undefined;
  readonly portableToolHistory?: ReadonlySet<ChatMessage> | undefined;
}

function compatibleReasoningFields(
  message: ChatMessage,
  replay?: CompatibleReasoningReplayOptions,
): {
  reasoningContent?: string | undefined;
  reasoningDetails?: unknown;
  thoughtSignature?: string | undefined;
} {
  if (!replay) return {};
  const artifacts = [
    ...selectReasoningArtifactsForReplay({
      artifacts: reasoningArtifactsForMessage(message),
      target: replay.target,
      observe: replay.observe,
      context: {
        forceScope: replay.forceScope,
        hasToolCalls: Boolean(message.toolCalls?.length),
      },
    }),
  ];
  const plaintext = artifacts.find(
    (artifact) => artifact.kind === "plaintext",
  );
  const details = artifacts.find(
    (artifact) => artifact.kind === "structured-details",
  );
  const signature = artifacts.find(
    (artifact) => artifact.kind === "thought-signature",
  );
  let reasoningContent = plaintext
    ? reasoningArtifactText(plaintext)
    : undefined;
  const isDeepSeek =
    replay.target.provider === "deepseek" ||
    Boolean(replay.target.model && /deepseek/i.test(replay.target.model));
  if (
    !reasoningContent &&
    isDeepSeek &&
    message.toolCalls?.length &&
    !message.reasoningArtifacts?.length &&
    message.reasoningBlock?.text
  ) {
    reasoningContent = message.reasoningBlock.text;
  }
  const thoughtSignature = signature
    ? reasoningArtifactSignature(signature)
    : undefined;
  return {
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(details ? { reasoningDetails: details.raw } : {}),
    ...(thoughtSignature ? { thoughtSignature } : {}),
  };
}

export function toOpenAiToolMessages(
  messages: ChatMessage[],
  mapUserContent: (message: ChatMessage) => string | unknown[],
  replay?: CompatibleReasoningReplayOptions,
): OpenAiWireMessage[] {
  const out: OpenAiWireMessage[] = [];
  const invalidHistory = invalidNativeToolHistoryIndexes(messages);
  const isDeepSeek =
    replay?.target?.provider === "deepseek" ||
    Boolean(replay?.target?.model && /deepseek/i.test(replay.target.model));
  for (const [index, message] of messages.entries()) {
    const portable =
      replay?.portableToolHistory?.has(message) || invalidHistory.has(index);
    if (message.role === "tool") {
      if (portable) {
        out.push({
          role: "user",
          content: portableToolResultContent(message, toWireName),
        });
        continue;
      }
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
        ...(message.name ? { name: toWireName(message.name) } : {}),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (portable) {
        if (replay?.observe) {
          compatibleReasoningFields(message, {
            ...replay,
            observe: (decision) => replay.observe?.({
              ...decision,
              action: "omitted",
              reason: decision.action === "replayed" ? "replay-disabled" : decision.reason,
            }),
          });
        }
        out.push({
          role: "assistant",
          content: portableToolCallContent(message, toWireName),
        });
        continue;
      }
      const reasoning = compatibleReasoningFields(message, replay);
      out.push({
        role: "assistant",
        content: isDeepSeek ? (message.content ?? "") : (message.content || null),
        ...(reasoning.reasoningContent !== undefined
          ? { reasoning_content: reasoning.reasoningContent }
          : {}),
        ...(reasoning.reasoningDetails !== undefined
          ? { reasoning_details: reasoning.reasoningDetails }
          : {}),
        ...(reasoning.thoughtSignature
          ? {
              extra_content: {
                google: { thought_signature: reasoning.thoughtSignature },
              },
            }
          : {}),
        tool_calls: message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: toWireName(tc.name),
            arguments: wireToolArguments(tc.rawArguments, tc.args),
          },
        })),
      });
      continue;
    }
    if (message.role === "user") {
      out.push({
        role: "user",
        content: mapUserContent(message),
      });
      continue;
    }
    const reasoning =
      message.role === "assistant"
        ? compatibleReasoningFields(message, replay)
        : {};
    out.push({
      role: message.role as "system" | "assistant",
      content: message.content,
      ...(reasoning.reasoningContent
        ? { reasoning_content: reasoning.reasoningContent }
        : {}),
      ...(reasoning.reasoningDetails !== undefined
        ? { reasoning_details: reasoning.reasoningDetails }
        : {}),
      ...(reasoning.thoughtSignature
        ? {
            extra_content: {
              google: { thought_signature: reasoning.thoughtSignature },
            },
          }
        : {}),
    });
  }
  return out;
}

export function openAiToolBodyFields(options: {
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): Record<string, unknown> {
  if (!options.tools?.length) return {};
  return {
    tools: toOpenAiTools(options.tools),
    tool_choice: mapToolChoiceToOpenAi(options.toolChoice),
    ...(options.parallelToolCalls === false
      ? { parallel_tool_calls: false }
      : {}),
  };
}

export function nativeToolCallsFromOpenAi(
  toolCalls: NativeToolCall[] | undefined,
): NativeToolCall[] | undefined {
  return toolCalls?.length ? toolCalls : undefined;
}
