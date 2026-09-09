import { createHash } from "node:crypto";
import type { ChatMessage, ToolDefinition } from "../../types.js";
import { currentSessionAffinity, withSessionAffinity } from "../session-affinity.js";
import type { OpenAiCompatibleResult } from "./reasoning-artifacts.js";
import type { ResponsesFirstOptions } from "./responses-first.js";
import type { ExtrasLevel } from "./responses-failure.js";

export interface ResponsesSelection {
  wire: "responses" | "chat";
  extras: ExtrasLevel;
}

interface PendingSelection {
  controller: AbortController;
  promise: Promise<ResponsesSelection>;
  waiters: number;
}

const MAX_ENTRIES = 400;
const CACHE_TTL_MS = 30 * 60 * 1000;
const selections = new Map<string, { value: ResponsesSelection; expiresAt: number }>();
const sessionSelections = new Map<string, ResponsesSelection>();
const pendingSelections = new Map<string, PendingSelection>();

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

export function preflightOptions(
  options: ResponsesFirstOptions,
  signal: AbortSignal,
): ResponsesFirstOptions {
  const name = typeof options.toolChoice === "object"
    ? options.toolChoice.name
    : "capability_probe";
  const tools: ToolDefinition[] | undefined = options.tools?.length ? [{
    name,
    wireName: options.tools.find((tool) => tool.name === name || tool.wireName === name)?.wireName ?? name,
    description: "Return the computed integer without side effects.",
    parameters: { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false },
  }] : undefined;
  const messages: ChatMessage[] = [{
    role: "user",
    content: "Find the smallest positive integer n such that n mod 7 = 3 and n mod 11 = 5. Use your reasoning channel if available, then give only the integer or return it through the provided tool.",
  }];
  return {
    ...options,
    messages,
    tools,
    maxTokens: Math.min(options.maxTokens ?? 512, 512),
    signal,
    reasoningArtifactReplayObserver: undefined,
  };
}

export function hasVisibleReasoning(result: OpenAiCompatibleResult): boolean {
  const text = result.reasoningBlock?.text.trim();
  return Boolean(text && !text.startsWith("Reasoning is private on "));
}

function selectionKey(options: ResponsesFirstOptions, streaming: boolean): string {
  const headers = [...new Headers(options.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify({
    provider: options.providerId,
    endpoint: options.baseUrl.replace(/\/+$/, ""),
    model: options.model,
    apiKey: options.apiKey,
    headers,
    streaming,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    temperature: options.temperature,
    tools: Boolean(options.tools?.length),
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
    includeStreamUsage: options.includeStreamUsage,
  })).digest("hex");
}

function waitForSelection(pending: PendingSelection, signal?: AbortSignal): Promise<ResponsesSelection> {
  signal?.throwIfAborted();
  pending.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: ResponsesSelection): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      pending.waiters -= 1;
      if (pending.waiters === 0) pending.controller.abort();
      if (value) resolve(value);
      else reject(error);
    };
    const onAbort = (): void => finish(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.promise.then((value) => finish(undefined, value), (error) => finish(error));
  });
}

export async function selectResponsesWire(
  options: ResponsesFirstOptions,
  streaming: boolean,
  probe: (signal: AbortSignal) => Promise<ResponsesSelection>,
): Promise<ResponsesSelection> {
  options.signal?.throwIfAborted();
  const key = selectionKey(options, streaming);
  const session = currentSessionAffinity();
  const sessionKey = session ? `${session}:${key}` : undefined;
  const pinned = sessionKey ? sessionSelections.get(sessionKey) : undefined;
  if (pinned) return pinned;
  const cached = selections.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (sessionKey) remember(sessionSelections, sessionKey, cached.value);
    return cached.value;
  }
  let pending = pendingSelections.get(key);
  if (!pending || pending.controller.signal.aborted) {
    const controller = new AbortController();
    const next: PendingSelection = {
      controller,
      waiters: 0,
      promise: Promise.resolve().then(async () => {
        const value = await withSessionAffinity(`preflight-${key}`, () => probe(controller.signal));
        controller.signal.throwIfAborted();
        remember(selections, key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }).finally(() => {
        if (pendingSelections.get(key) === next) pendingSelections.delete(key);
      }),
    };
    pendingSelections.set(key, next);
    pending = next;
  }
  const value = await waitForSelection(pending, options.signal);
  if (sessionKey) remember(sessionSelections, sessionKey, value);
  return value;
}

export function resetResponsesPreflight(): void {
  selections.clear();
  sessionSelections.clear();
  for (const pending of pendingSelections.values()) pending.controller.abort();
  pendingSelections.clear();
}
