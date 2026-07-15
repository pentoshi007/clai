import type { OutputChunkRef, ToolCallId } from "./app-event.js";

/**
 * Text buffer for a single tool stream. By default it keeps **all** characters
 * (no truncation) so Ctrl+O / click-to-open always shows the full body.
 * Pass a finite `maxChars` only for tests or memory-sensitive adapters.
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

  /**
   * @param maxChars Finite positive cap keeps only the last N chars.
   *   `Infinity` / `Number.POSITIVE_INFINITY` (default) keeps everything.
   */
  constructor(private readonly maxChars: number = Number.POSITIVE_INFINITY) {
    if (!(this.maxChars > 0)) throw new RangeError("maxChars must be positive");
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += Buffer.byteLength(chunk, "utf8");
    const combined = this.tailBuf + chunk;
    if (!Number.isFinite(this.maxChars) || combined.length <= this.maxChars) {
      this.tailBuf = combined;
      return;
    }
    const overflow = combined.length - this.maxChars;
    this.dropped += Buffer.byteLength(combined.slice(0, overflow), "utf8");
    this.tailBuf = combined.slice(overflow);
  }

  /** Replace the buffer with an authoritative full body (never truncated). */
  replace(text: string): void {
    this.tailBuf = text;
    this.total = Buffer.byteLength(text, "utf8");
    this.dropped = 0;
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
 * Per-tool-call output spool. Default is unbounded so the UI never loses
 * bytes. Full artifacts are still written to disk for persistence/export.
 */
export class OutputSpool {
  private readonly byTool = new Map<ToolCallId, BoundedText>();

  /** @param maxCharsPerTool Default Infinity — keep full output. */
  constructor(private readonly maxCharsPerTool = Number.POSITIVE_INFINITY) {}

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

  /**
   * Set the full authoritative body after a tool finishes (replaces any live
   * stream so the pager never shows a truncated mid-run preview).
   */
  replace(toolCallId: ToolCallId, text: string): OutputChunkRef {
    let buffer = this.byTool.get(toolCallId);
    if (!buffer) {
      buffer = new BoundedText(this.maxCharsPerTool);
      this.byTool.set(toolCallId, buffer);
    }
    buffer.replace(text);
    return {
      toolCallId,
      chunkBytes: Buffer.byteLength(text, "utf8"),
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
