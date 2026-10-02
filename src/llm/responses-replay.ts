import type { ChatMessage, ResponsesReplay } from "../types.js";
import { fromWireName } from "./tool-protocol.js";

export function captureResponsesReplay(provider: string, model: string, output: unknown): ResponsesReplay | undefined {
  if (provider !== "codex" || !Array.isArray(output) || output.length === 0) return undefined;
  const items = output.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)
      && ["message", "reasoning", "function_call"].includes(item.type)),
  );
  if (items.length !== output.length) return undefined;
  return { provider, model, items: structuredClone(items) };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function responsesReplayItems(message: ChatMessage, provider: string, model: string): readonly Record<string, unknown>[] | undefined {
  const replay = message.responsesReplay;
  if (provider !== "codex" || replay?.provider !== provider || replay.model !== model || !Array.isArray(replay.items)) return undefined;
  let text = "";
  const calls: Array<{ id: unknown; name: string; args: unknown }> = [];
  for (const item of replay.items) {
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    } else if (item.type === "function_call" && typeof item.arguments === "string" && typeof item.name === "string") {
      try {
        calls.push({ id: item.call_id, name: fromWireName(item.name) ?? item.name, args: JSON.parse(item.arguments) });
      } catch {
        return undefined;
      }
    } else if (item.type !== "reasoning") {
      return undefined;
    }
  }
  const currentCalls = (message.toolCalls ?? []).map(({ id, name, args }) => ({ id, name, args }));
  if (text.trim() !== message.content.trim() || canonicalJson(calls) !== canonicalJson(currentCalls)) return undefined;
  return replay.items;
}
