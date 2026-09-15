import { isKeyRotatableError, buildKeyAttemptPlan } from "../../llm/key-rotation.js";
import { isRateLimited, isRetriableError } from "../../llm/routing/error-classification.js";
import { streamEmittedBytes } from "../../llm/stream-progress.js";
import { getConfig, type ClaiConfig } from "../../store/config/endpoints.js";
import { sanitizeSubagentModelChain } from "../../store/config/subagent-models.js";
import type { ChatMessage, NativeToolCall, ProviderId, ToolCall } from "../../types.js";

export interface SubagentModelRoute {
  provider: ProviderId;
  model: string;
}

export interface SubagentStreamResult<T> {
  value: T;
  streamedBytes?: number | undefined;
}

export interface SubagentModelRotationOptions<T> {
  candidates: readonly SubagentModelRoute[];
  signal: AbortSignal;
  stream: (
    route: SubagentModelRoute,
    attempt: number,
  ) => Promise<SubagentStreamResult<T>>;
  startIndex?: number | undefined;
  attemptsPerCandidate?: number | undefined;
  shouldRotate?: ((error: unknown) => boolean) | undefined;
  onRoute?: ((route: SubagentModelRoute, index: number) => void) | undefined;
  onSwitch?: ((error: unknown, route: SubagentModelRoute, index: number) => void) | undefined;
}

export interface SubagentModelRotationResult<T> {
  value: T;
  route: SubagentModelRoute;
  index: number;
}

export async function runSubagentModelRotation<T>({
  candidates,
  signal,
  stream,
  startIndex = 0,
  attemptsPerCandidate = 2,
  shouldRotate = (error) => isKeyRotatableError(error, isRetriableError) || isRateLimited(error),
  onRoute,
  onSwitch,
}: SubagentModelRotationOptions<T>): Promise<SubagentModelRotationResult<T>> {
  if (!candidates.length) throw new Error("No subagent model candidates configured");
  const first = Math.min(Math.max(Math.trunc(startIndex), 0), candidates.length - 1);
  const attempts = Math.max(1, Math.trunc(attemptsPerCandidate));
  let lastError: unknown;
  for (let index = first; index < candidates.length; index += 1) {
    const route = candidates[index]!;
    onRoute?.(route, index);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      signal.throwIfAborted();
      try {
        const result = await stream(route, attempt);
        signal.throwIfAborted();
        return { value: result.value, route, index };
      } catch (error) {
        signal.throwIfAborted();
        if (streamEmittedBytes(error) > 0 || !shouldRotate(error)) throw error;
        lastError = error;
        if (attempt + 1 < attempts) continue;
        if (index + 1 >= candidates.length) throw error;
        onSwitch?.(error, candidates[index + 1]!, index + 1);
      }
    }
  }
  throw lastError ?? new Error("All subagent model candidates failed");
}

function toolCallText(call: ToolCall): string {
  return `\`\`\`tool\n${JSON.stringify({ name: call.name, args: call.args })}\n\`\`\``;
}

function nativeToFenced(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: `Untrusted tool result for ${message.name ?? "tool"}:\n${message.content}`,
      };
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) return { ...message };
    const suffix = message.toolCalls.map((call) => toolCallText(call)).join("\n");
    return {
      ...message,
      content: message.content ? `${message.content}\n${suffix}` : suffix,
      toolCalls: undefined,
    };
  });
}

function parseFencedCalls(content: string): { text: string; calls: NativeToolCall[] } {
  const calls: NativeToolCall[] = [];
  const text = content.replace(/```tool\s*\n?([\s\S]*?)```/gi, (block, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; args?: unknown };
      if (typeof parsed.name !== "string" || typeof parsed.args !== "object" || parsed.args === null || Array.isArray(parsed.args)) return block;
      calls.push({ id: `subagent-tool-${calls.length + 1}`, name: parsed.name, args: parsed.args as Record<string, unknown> });
      return "";
    } catch {
      return block;
    }
  }).trim();
  return { text, calls };
}

function fencedToNative(messages: readonly ChatMessage[]): ChatMessage[] {
  let lastCalls: NativeToolCall[] = [];
  return messages.map((message) => {
    if (message.role === "assistant") {
      const parsed = parseFencedCalls(message.content);
      lastCalls = parsed.calls;
      return {
        ...message,
        content: parsed.text,
        ...(parsed.calls.length ? { toolCalls: parsed.calls } : {}),
      };
    }
    if (message.role !== "user") return { ...message };
    const result = message.content.match(/^Untrusted tool result for ([^:\n]+):\n([\s\S]*)$/);
    if (!result) return { ...message };
    const name = result[1]!.trim();
    const call = lastCalls.find((candidate) => candidate.name === name);
    return {
      role: "tool",
      name,
      content: result[2]!,
      ...(call ? { toolCallId: call.id } : {}),
    };
  });
}

export function adaptSubagentHistory(
  messages: readonly ChatMessage[],
  fromNative: boolean,
  toNative: boolean,
): ChatMessage[] {
  if (fromNative === toNative) return messages.map((message) => ({ ...message }));
  return toNative ? fencedToNative(messages) : nativeToFenced(messages);
}

export function resolveSubagentModelChain(
  config: Pick<ClaiConfig, "subagentModels" | "customProviders"> = getConfig(),
): SubagentModelRoute[] {
  const chain = sanitizeSubagentModelChain(config.subagentModels, config.customProviders);
  if (!chain) return [];
  return buildKeyAttemptPlan(chain.entries.length, chain.activeIndex)
    .map((index) => chain.entries[index]!)
    .filter((entry) => entry.disabled !== true)
    .map((entry) => ({ provider: entry.provider as ProviderId, model: entry.model }));
}
