import type { NativeToolCall } from "../../types.js";
import {
  fromWireName,
  parseToolArguments,
  syntheticToolCallId,
} from "../tool-protocol.js";
import type {
  AnthropicThinkingBlock,
  AnthropicWireContentBlock,
} from "./anthropic-tools.js";

export function parseAnthropicToolUseBlocks(
  content: AnthropicWireContentBlock[] | undefined,
): {
  text: string;
  thinkingText: string;
  thinkingBlocks: AnthropicThinkingBlock[];
  toolCalls: NativeToolCall[];
  thinkingSignature?: string;
} {
  let text = "";
  let thinkingText = "";
  let thinkingSignature: string | undefined;
  const toolCalls: NativeToolCall[] = [];
  const thinkingBlocks: Array<Omit<AnthropicThinkingBlock, "toolCallIndex">> =
    [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> =
    [];
  if (!content) return { text, thinkingText, thinkingBlocks, toolCalls };

  for (const [sequence, part] of content.entries()) {
    if (part.type === "text" && part.text) text += part.text;
    if (part.type === "thinking") {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      if (thinking) thinkingText += thinking;
      if (typeof part.signature === "string" && part.signature) {
        thinkingSignature = part.signature;
      }
      thinkingBlocks.push({
        sequence,
        thinking,
        ...(typeof part.signature === "string" && part.signature
          ? { signature: part.signature }
          : {}),
        raw: { ...part },
      });
    }
    if (part.type === "tool_use") {
      const wire = part.name ?? "";
      const input = part.input;
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : parseToolArguments(
              typeof input === "string" ? input : JSON.stringify(input ?? {}),
            );
      const toolCallIndex = toolCalls.length;
      toolCalls.push({
        id: part.id ?? syntheticToolCallId(toolCallIndex),
        name: fromWireName(wire) ?? wire,
        args,
      });
      toolCallSequences.push({ sequence, toolCallIndex });
    }
  }
  const positionedThinkingBlocks = thinkingBlocks.map((block) => {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > block.sequence,
    );
    return followingTool
      ? { ...block, toolCallIndex: followingTool.toolCallIndex }
      : block;
  });
  return {
    text: text.trim(),
    thinkingText: thinkingText.trim(),
    thinkingBlocks: positionedThinkingBlocks,
    toolCalls,
    ...(thinkingSignature ? { thinkingSignature } : {}),
  };
}
