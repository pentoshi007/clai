import type { ChatMessage, NativeToolCall, ToolDefinition } from "../../types.js";
import {
  fromWireName,
  parseToolArguments,
  syntheticToolCallId,
  toWireName,
} from "../tool-protocol.js";
import "../../tools/definitions.js";
import { toOpenAiTools } from "./openai-tools.js";

export function toOllamaTools(defs: ToolDefinition[]) {
  return toOpenAiTools(defs);
}


export function toOllamaToolMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.name
          ? { name: toWireName(message.name), tool_name: toWireName(message.name) }
          : {}),
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: toWireName(tc.name),
            arguments: tc.args ?? {},
          },
        })),
      };
    }
    if (message.role === "user" && message.images?.length) {
      return {
        role: "user",
        content: message.content,
        images: message.images.map((img) => img.dataBase64),
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function parseOllamaToolCalls(
  toolCalls:
    | Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string | Record<string, unknown>;
        };
      }>
    | undefined,
): NativeToolCall[] {
  if (!toolCalls?.length) return [];
  return toolCalls.map((tc, i) => {
    const wire = tc.function?.name ?? "";
    const raw = tc.function?.arguments;
    const rawArguments =
      typeof raw === "string" ? raw : raw ? JSON.stringify(raw) : undefined;
    return {
      id: tc.id ?? syntheticToolCallId(i),
      name: fromWireName(wire) ?? wire,
      args: parseToolArguments(raw),
      ...(rawArguments ? { rawArguments } : {}),
    };
  });
}
