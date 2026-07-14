import type { OutputChunkRef, ToolCallId } from "./app-event.js";

/**
 * Bounded tail buffer for a single stream. Keeps only the last `maxChars`
 * characters in memory while tracking the full byte total and how much was
 * evicted, so a 10 MB tool stream never lives in reactive state (PERF-003).
 * Full bytes remain in the tool's artifact file on disk.
 */
export interface BoundedTextState {
  readonly tail: string;
  readonly totalBytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
}

export class BoundedText {
  private tailBuf = "";
  private total = 0;
  private dropped = 0;

  constructor(private readonly maxChars = 20_000) {
    if (maxChars <= 0) throw new RangeError("maxChars must be positive");
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += Buffer.byteLength(chunk, "utf8");
    const combined = this.tailBuf + chunk;
    if (combined.length <= this.maxChars) {
      this.tailBuf = combined;
      return;
    }
    const overflow = combined.length - this.maxChars;
    this.dropped += Buffer.byteLength(combined.slice(0, overflow), "utf8");
    this.tailBuf = combined.slice(overflow);
  }

  get tail(): string {
    return this.tailBuf;
  }

  get totalBytes(): number {
    return this.total;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  snapshot(): BoundedTextState {
    return {
      tail: this.tailBuf,
      totalBytes: this.total,
      droppedBytes: this.dropped,
      truncated: this.dropped > 0,
    };
  }
}

/**
 * Per-tool-call output spool. The adapter appends chunks here and emits only a
 * lightweight `OutputChunkRef` on the event stream; components read the bounded
 * tail by id instead of receiving an ever-growing string in every event.
 */
export class OutputSpool {
  private readonly byTool = new Map<ToolCallId, BoundedText>();

  constructor(private readonly maxCharsPerTool = 20_000) {}

  append(toolCallId: ToolCallId, chunk: string): OutputChunkRef {
    let buffer = this.byTool.get(toolCallId);
    if (!buffer) {
      buffer = new BoundedText(this.maxCharsPerTool);
      this.byTool.set(toolCallId, buffer);
    }
    buffer.append(chunk);
    return {
      toolCallId,
      chunkBytes: Buffer.byteLength(chunk, "utf8"),
      totalBytes: buffer.totalBytes,
    };
  }

  tail(toolCallId: ToolCallId): string {
    return this.byTool.get(toolCallId)?.tail ?? "";
  }

  state(toolCallId: ToolCallId): BoundedTextState | undefined {
    return this.byTool.get(toolCallId)?.snapshot();
  }

  has(toolCallId: ToolCallId): boolean {
    return this.byTool.has(toolCallId);
  }

  clear(): void {
    this.byTool.clear();
  }
}
