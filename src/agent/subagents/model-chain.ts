import { buildKeyAttemptPlan, isKeyCircleStopError, isKeyRotatableError } from "../../llm/key-rotation.js";
import { isModelNotFoundError, isRateLimited, isRetriableError } from "../../llm/routing/error-classification.js";
import { streamEmittedBytes } from "../../llm/stream-progress.js";
import { getConfig, type ClaiConfig } from "../../store/config/endpoints.js";
import { sanitizeSubagentModelChain } from "../../store/config/subagent-models.js";
import type { ChatMessage, NativeToolCall, ProviderId, ToolCall } from "../../types.js";

export interface SubagentModelRoute {
  provider: ProviderId;
  model: string;
}

const ROUTE_FAILURE = Symbol.for("clai.subagent.routeFailure");

export function markSubagentRouteFailure<E>(error: E): E {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, ROUTE_FAILURE, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
    }
  }
  return error;
}

export function isSubagentRouteFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && ROUTE_FAILURE in error;
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
  shouldRotate = (error) =>
    isSubagentRouteFailure(error) ||
    isKeyRotatableError(error, isRetriableError) ||
    isRateLimited(error) ||
    isModelNotFoundError(error) ||
    isKeyCircleStopError(error),
  onRoute,
  onSwitch,
}: SubagentModelRotationOptions<T>): Promise<SubagentModelRotationResult<T>> {
  if (!candidates.length) throw new Error("No subagent model candidates configured");
  const total = candidates.length;
  const first = Math.min(Math.max(Math.trunc(startIndex), 0), total - 1);
  const attempts = Math.max(1, Math.trunc(attemptsPerCandidate));
  let lastError: unknown;
  for (let step = 0; step < total; step += 1) {
    const index = (first + step) % total;
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
        if (step + 1 >= total) throw error;
        const next = (index + 1) % total;
        onSwitch?.(error, candidates[next]!, next);
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

function parseFencedCalls(content: string, nextId: () => string): { text: string; calls: NativeToolCall[] } {
  const calls: NativeToolCall[] = [];
  const text = content.replace(/```tool\s*\n?([\s\S]*?)```/gi, (block, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; args?: unknown };
      if (typeof parsed.name !== "string" || typeof parsed.args !== "object" || parsed.args === null || Array.isArray(parsed.args)) return block;
      calls.push({ id: nextId(), name: parsed.name, args: parsed.args as Record<string, unknown> });
      return "";
    } catch {
      return block;
    }
  }).trim();
  return { text, calls };
}

function fencedToNative(messages: readonly ChatMessage[]): ChatMessage[] {
  let callSequence = 0;
  let pending: NativeToolCall[] = [];
  return messages.map((message) => {
    if (message.role === "assistant") {
      const parsed = parseFencedCalls(message.content, () => `subagent-tool-${(callSequence += 1)}`);
      pending = [...parsed.calls];
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
    const call = pending.shift();
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

export function subagentModelChainBlocked(
  config: Pick<ClaiConfig, "subagentModels" | "customProviders"> = getConfig(),
): boolean {
  const chain = sanitizeSubagentModelChain(config.subagentModels, config.customProviders);
  return Boolean(chain) && !resolveSubagentModelChain(config).length;
}
