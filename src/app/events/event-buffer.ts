import type { OutputChunkRef, ToolCallId } from "./app-event.js";
import { copyString } from "../../os/copy-string.js";


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
    this.tailBuf = copyString(combined.slice(overflow));
  }

  replace(text: string): void {
    this.tailBuf = "";
    this.total = 0;
    this.dropped = 0;
    this.append(text);
  }

  restore(text: string, state: Pick<BoundedTextState, "totalBytes" | "droppedBytes">): void {
    this.replace(text);
    this.total = Math.max(this.total, state.totalBytes);
    this.dropped = Math.max(this.dropped, state.droppedBytes);
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


export type DeferredOutput = () => string | undefined;

export class OutputSpool {
  private readonly byTool = new Map<ToolCallId, BoundedText>();
  private readonly deferred = new Map<ToolCallId, DeferredOutput>();
  private readonly reloaders = new Map<ToolCallId, DeferredOutput>();
  private readonly residentArtifacts = new Set<ToolCallId>();
  private readonly released = new Map<ToolCallId, Pick<BoundedTextState, "totalBytes" | "droppedBytes">>();
  private readonly versions = new Map<ToolCallId, number>();
  private residentCharsValue = 0;

  constructor(
    private readonly maxCharsPerTool = 256 * 1024,
    private readonly maxResidentChars = 8 * 1024 * 1024,
  ) {
    if (!(maxResidentChars > 0)) throw new RangeError("maxResidentChars must be positive");
  }

  get residentChars(): number {
    return this.residentCharsValue;
  }

  version(toolCallId: ToolCallId): number {
    return this.versions.get(toolCallId) ?? 0;
  }

  private changed(toolCallId: ToolCallId): void {
    this.versions.set(toolCallId, this.version(toolCallId) + 1);
    this.released.delete(toolCallId);
    this.reloaders.delete(toolCallId);
    this.residentArtifacts.delete(toolCallId);
  }

  private trim(protectedId?: ToolCallId): void {
    if (this.residentCharsValue <= this.maxResidentChars) return;
    for (const id of this.residentArtifacts) {
      const buffer = this.byTool.get(id);
      const reload = this.reloaders.get(id);
      if (id === protectedId || !buffer || !reload) continue;
      this.released.set(id, { totalBytes: buffer.totalBytes, droppedBytes: buffer.droppedBytes });
      this.residentCharsValue -= buffer.tail.length;
      this.byTool.delete(id);
      this.residentArtifacts.delete(id);
      this.deferred.set(id, reload);
      if (this.residentCharsValue <= this.maxResidentChars) break;
    }
  }

  private bufferFor(toolCallId: ToolCallId): BoundedText {
    let buffer = this.byTool.get(toolCallId);
    if (buffer) return buffer;
    buffer = new BoundedText(this.maxCharsPerTool);
    this.byTool.set(toolCallId, buffer);
    return buffer;
  }

  private resolve(toolCallId: ToolCallId): BoundedText | undefined {
    const load = this.deferred.get(toolCallId);
    if (load) {
      this.deferred.delete(toolCallId);
      let text: string | undefined;
      try {
        text = load();
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        const buffer = this.bufferFor(toolCallId);
        this.residentCharsValue -= buffer.tail.length;
        const released = this.released.get(toolCallId);
        if (released) buffer.restore(text, released);
        else buffer.replace(text);
        this.residentCharsValue += buffer.tail.length;
        this.released.delete(toolCallId);
        this.residentArtifacts.add(toolCallId);
        this.trim(toolCallId);
      } else {
        this.deferred.set(toolCallId, load);
      }
    }
    const buffer = this.byTool.get(toolCallId);
    if (buffer && this.reloaders.has(toolCallId)) {
      this.residentArtifacts.delete(toolCallId);
      this.residentArtifacts.add(toolCallId);
    }
    return buffer;
  }

  append(toolCallId: ToolCallId, chunk: string): OutputChunkRef {
    this.resolve(toolCallId);
    this.changed(toolCallId);
    const buffer = this.bufferFor(toolCallId);
    this.residentCharsValue -= buffer.tail.length;
    buffer.append(chunk);
    this.residentCharsValue += buffer.tail.length;
    this.trim(toolCallId);
    return {
      toolCallId,
      chunkBytes: Buffer.byteLength(chunk, "utf8"),
      totalBytes: buffer.totalBytes,
    };
  }

  replace(toolCallId: ToolCallId, text: string): OutputChunkRef {
    this.deferred.delete(toolCallId);
    this.changed(toolCallId);
    const buffer = this.bufferFor(toolCallId);
    this.residentCharsValue -= buffer.tail.length;
    buffer.replace(text);
    this.residentCharsValue += buffer.tail.length;
    this.trim(toolCallId);
    return {
      toolCallId,
      chunkBytes: Buffer.byteLength(text, "utf8"),
      totalBytes: buffer.totalBytes,
    };
  }

  defer(toolCallId: ToolCallId, load: DeferredOutput): void {
    this.deferred.set(toolCallId, load);
    this.reloaders.set(toolCallId, load);
    if (this.byTool.has(toolCallId)) this.residentArtifacts.add(toolCallId);
    this.versions.set(toolCallId, this.version(toolCallId) + 1);
    this.trim();
  }

  retainArtifact(toolCallId: ToolCallId, load: DeferredOutput): void {
    this.reloaders.set(toolCallId, load);
    if (this.byTool.has(toolCallId)) this.residentArtifacts.add(toolCallId);
    else this.deferred.set(toolCallId, load);
    this.trim();
  }

  tail(toolCallId: ToolCallId): string {
    return this.resolve(toolCallId)?.tail ?? "";
  }

  peekTail(toolCallId: ToolCallId): string {
    return this.byTool.get(toolCallId)?.tail ?? "";
  }

  state(toolCallId: ToolCallId): BoundedTextState | undefined {
    return this.resolve(toolCallId)?.snapshot();
  }

  has(toolCallId: ToolCallId): boolean {
    return this.byTool.has(toolCallId) || this.deferred.has(toolCallId);
  }

  clear(): void {
    this.byTool.clear();
    this.deferred.clear();
    this.reloaders.clear();
    this.residentArtifacts.clear();
    this.released.clear();
    this.versions.clear();
    this.residentCharsValue = 0;
  }
}
