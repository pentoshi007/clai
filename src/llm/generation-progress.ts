import type { TokenUsage } from "../types.js";
import { generationTokensPerSecond, type GenerationProgress } from "./generation-metrics.js";
import type { ProviderStreamEvent } from "./stream-events.js";

const UPDATE_INTERVAL_MS = 250;
const ESTIMATED_CHARACTERS_PER_TOKEN = 3.3;

export class GenerationProgressTracker {
  private startedAt: number;
  private lastPublishedAt: number | undefined;
  private outputUnits = 0;
  private observedTokens = 0;
  private observedUnits = 0;
  private closed = false;
  private readonly tools = new Map<number, { name: number; arguments: number }>();

  constructor(
    private readonly publish: (metrics: GenerationProgress) => void,
    startedAt: number,
    private readonly signal?: AbortSignal | undefined,
  ) {
    this.startedAt = startedAt;
  }

  reset(startedAt: number): void {
    this.startedAt = startedAt;
    this.lastPublishedAt = undefined;
    this.outputUnits = 0;
    this.observedTokens = 0;
    this.observedUnits = 0;
    this.tools.clear();
  }

  close(): void {
    this.closed = true;
  }

  observe(event: ProviderStreamEvent): void {
    if (this.closed || this.signal?.aborted) return;
    switch (event.type) {
      case "answer_delta":
      case "commentary_delta":
      case "reasoning_delta":
        if (!event.text) return;
        this.outputUnits += event.text.length;
        break;
      case "tool_call_started":
      case "tool_call_completed":
      case "tool_arguments_delta":
        if (!this.observeTool(event)) return;
        break;
      case "usage_observed":
        this.observeUsage(event.usage);
        return;
      default:
        return;
    }
    const outputTokens = this.observedTokens + Math.ceil(
      Math.max(0, this.outputUnits - this.observedUnits) / ESTIMATED_CHARACTERS_PER_TOKEN,
    );
    this.emit(outputTokens, true);
  }

  observeUsage(usage: TokenUsage | undefined): void {
    if (this.closed || this.signal?.aborted || !usage?.exact ||
        !Number.isSafeInteger(usage.completionTokens) || usage.completionTokens <= 0) return;
    this.observedTokens = usage.completionTokens;
    this.observedUnits = this.outputUnits;
    this.emit(this.observedTokens, false);
  }

  private emit(outputTokens: number, estimated: boolean): void {
    const now = performance.now();
    const durationMs = now - this.startedAt;
    if (durationMs < UPDATE_INTERVAL_MS ||
        (this.lastPublishedAt !== undefined && now - this.lastPublishedAt < UPDATE_INTERVAL_MS)) return;
    const metrics: GenerationProgress = { outputTokens, durationMs, ...(estimated ? { estimated: true } : {}) };
    if (generationTokensPerSecond(metrics) === undefined) return;
    this.lastPublishedAt = now;
    this.publish(metrics);
  }

  private observeTool(
    event: Extract<ProviderStreamEvent, { type: "tool_call_started" | "tool_call_completed" | "tool_arguments_delta" }>,
  ): boolean {
    if (!Number.isSafeInteger(event.index) || event.index < 0) return false;
    const previous = this.tools.get(event.index) ?? { name: 0, arguments: 0 };
    const name = event.type === "tool_arguments_delta" ? previous.name : Math.max(previous.name, event.name.length);
    const bytes = event.type === "tool_arguments_delta" ? event.argumentsBytes : previous.arguments;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    const args = Math.max(previous.arguments, bytes);
    const delta = name - previous.name + args - previous.arguments;
    if (delta === 0) return false;
    this.tools.set(event.index, { name, arguments: args });
    this.outputUnits += delta;
    return true;
  }
}
