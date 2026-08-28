export const DEFAULT_REPLAY_BYTES = 2 * 1024 * 1024;

export class TerminalReplayBuffer {
  private chunks: Buffer[] = [];
  private byteLengthValue = 0;

  constructor(private readonly limitBytes = DEFAULT_REPLAY_BYTES) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new Error("terminal replay limit must be a positive integer");
    }
  }

  get byteLength(): number {
    return this.byteLengthValue;
  }

  append(value: Uint8Array): void {
    if (value.byteLength === 0) return;
    let chunk = Buffer.from(value);
    if (chunk.length >= this.limitBytes) {
      chunk = chunk.subarray(chunk.length - this.limitBytes);
      this.chunks = [chunk];
      this.byteLengthValue = chunk.length;
      return;
    }
    this.chunks.push(chunk);
    this.byteLengthValue += chunk.length;
    this.trim();
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks, this.byteLengthValue);
  }

  clear(): void {
    this.chunks = [];
    this.byteLengthValue = 0;
  }

  private trim(): void {
    while (this.byteLengthValue > this.limitBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.byteLengthValue - this.limitBytes;
      if (first.length <= excess) {
        this.chunks.shift();
        this.byteLengthValue -= first.length;
        continue;
      }
      this.chunks[0] = first.subarray(excess);
      this.byteLengthValue -= excess;
    }
  }
}
