const PRECISE_ROWS_PER_FRAME = 2;
const WHEEL_SETTLE_MS = 50;

export class WheelScroll {
  private pending = 0;
  private lastInputAt = 0;
  private lastFrameAt = 0;

  get active(): boolean {
    return this.pending !== 0;
  }

  push(notches: number, now = performance.now()): void {
    if (!Number.isFinite(notches) || notches === 0) return;
    if (!this.active || Math.sign(notches) !== Math.sign(this.pending)) {
      this.pending = 0;
      this.lastFrameAt = now;
    }
    this.pending += notches;
    this.lastInputAt = now;
  }

  step(now = performance.now()): number {
    if (!this.active) return 0;
    const remainingMs = Math.max(1, this.lastInputAt + WHEEL_SETTLE_MS - this.lastFrameAt);
    const elapsedMs = Math.max(1, now - this.lastFrameAt);
    const progress = Math.min(1, elapsedMs / remainingMs);
    const distance = Math.min(
      Math.abs(this.pending),
      Math.max(PRECISE_ROWS_PER_FRAME, Math.ceil(Math.abs(this.pending) * progress)),
    );
    const rows = Math.sign(this.pending) * distance;
    this.lastFrameAt = now;
    this.pending -= rows;
    return rows;
  }

  stop(): void {
    this.pending = 0;
  }
}
