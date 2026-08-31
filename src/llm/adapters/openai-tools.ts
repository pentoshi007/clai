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
import {
  mapToolChoiceToOpenAi,
  toWireName,
  type ToolChoice,
} from "../tool-protocol.js";
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
      context: {
        hasToolCalls: Boolean(message.toolCalls?.length),
        ...(replay.forceScope ? { forceScope: true } : {}),
      },
      observe: replay.observe,
    }),
  ].sort((left, right) => left.position.sequence - right.position.sequence);
  const plaintext = artifacts.find((artifact) => artifact.kind === "plaintext");
  const details = artifacts.find(
    (artifact) => artifact.kind === "structured-details",
  );
  const signature = artifacts.find(
    (artifact) => artifact.kind === "thought-signature",
  );
  const reasoningContent = plaintext
    ? reasoningArtifactText(plaintext)
    : undefined;
  const thoughtSignature = signature
    ? reasoningArtifactSignature(signature)
    : undefined;
  return {
    ...(reasoningContent ? { reasoningContent } : {}),
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
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
        ...(message.name ? { name: toWireName(message.name) } : {}),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const reasoning = compatibleReasoningFields(message, replay);
      out.push({
        role: "assistant",
        content: message.content || null,
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
        tool_calls: message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: toWireName(tc.name),
            arguments: tc.rawArguments ?? JSON.stringify(tc.args ?? {}),
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
