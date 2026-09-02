import type { OutputChunkRef, ToolCallId } from "./app-event.js";


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

  constructor(private readonly maxChars: number = 256 * 1024) {
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

  replace(text: string): void {
    this.tailBuf = "";
    this.total = 0;
    this.dropped = 0;
    this.append(text);
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


export class OutputSpool {
  private readonly byTool = new Map<ToolCallId, BoundedText>();

  constructor(
    private readonly maxCharsPerTool = 256 * 1024,
    private readonly maxTools = 128,
  ) {
    if (!Number.isInteger(maxTools) || maxTools <= 0) throw new RangeError("maxTools must be positive");
  }

  private bufferFor(toolCallId: ToolCallId): BoundedText {
    let buffer = this.byTool.get(toolCallId);
    if (buffer) return buffer;
    while (this.byTool.size >= this.maxTools) {
      const oldest = this.byTool.keys().next().value as ToolCallId | undefined;
      if (oldest === undefined) break;
      this.byTool.delete(oldest);
    }
    buffer = new BoundedText(this.maxCharsPerTool);
    this.byTool.set(toolCallId, buffer);
    return buffer;
  }

  append(toolCallId: ToolCallId, chunk: string): OutputChunkRef {
    const buffer = this.bufferFor(toolCallId);
    buffer.append(chunk);
    return {
      toolCallId,
      chunkBytes: Buffer.byteLength(chunk, "utf8"),
      totalBytes: buffer.totalBytes,
    };
  }

  
  replace(toolCallId: ToolCallId, text: string): OutputChunkRef {
    const buffer = this.bufferFor(toolCallId);
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
