const MAX_PENDING_BYTES = 1024 * 1024;

export class TerminalAttachOutput {
  private replay: Uint8Array | undefined;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private disposed = false;

  constructor(
    replay: Uint8Array,
    private readonly write: (bytes: Uint8Array) => void,
    private readonly limitBytes = MAX_PENDING_BYTES,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new Error("terminal attach limit must be a positive integer");
    }
    this.replay = replay;
  }

  push(bytes: Uint8Array): void {
    if (this.disposed || bytes.byteLength === 0) return;
    if (this.replay === undefined) {
      this.write(bytes);
      return;
    }
    if (this.pendingBytes + bytes.byteLength > this.limitBytes) {
      this.finish(false);
      this.write(bytes);
      return;
    }
    this.pending.push(Buffer.from(bytes));
    this.pendingBytes += bytes.byteLength;
  }

  finish(repaintAccepted: boolean): void {
    if (this.disposed || this.replay === undefined) return;
    const replay = this.replay;
    const pending = this.pending;
    this.replay = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    if (!repaintAccepted && replay.byteLength > 0) this.write(replay);
    for (const bytes of pending) this.write(bytes);
  }

  dispose(): void {
    this.disposed = true;
    this.replay = undefined;
    this.pending = [];
    this.pendingBytes = 0;
  }
}
