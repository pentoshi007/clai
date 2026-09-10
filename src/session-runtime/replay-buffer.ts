export const DEFAULT_REPLAY_BYTES = 2 * 1024 * 1024;

export class TerminalReplayBuffer {
  private buffer: Buffer | undefined;
  private writeOffset = 0;
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
    const buffer = this.buffer ??= Buffer.allocUnsafe(this.limitBytes);
    if (value.byteLength >= this.limitBytes) {
      buffer.set(value.subarray(value.byteLength - this.limitBytes));
      this.writeOffset = 0;
      this.byteLengthValue = this.limitBytes;
      return;
    }
    const firstLength = Math.min(value.byteLength, this.limitBytes - this.writeOffset);
    buffer.set(value.subarray(0, firstLength), this.writeOffset);
    if (firstLength < value.byteLength) buffer.set(value.subarray(firstLength));
    this.writeOffset = (this.writeOffset + value.byteLength) % this.limitBytes;
    this.byteLengthValue = Math.min(this.limitBytes, this.byteLengthValue + value.byteLength);
  }

  snapshot(): Buffer {
    const snapshot = Buffer.allocUnsafe(this.byteLengthValue);
    if (!this.buffer || this.byteLengthValue === 0) return snapshot;
    const start = this.byteLengthValue === this.limitBytes ? this.writeOffset : 0;
    const firstLength = Math.min(this.byteLengthValue, this.limitBytes - start);
    this.buffer.copy(snapshot, 0, start, start + firstLength);
    if (firstLength < this.byteLengthValue) {
      this.buffer.copy(snapshot, firstLength, 0, this.byteLengthValue - firstLength);
    }
    return snapshot;
  }

  clear(): void {
    this.buffer = undefined;
    this.writeOffset = 0;
    this.byteLengthValue = 0;
  }
}
