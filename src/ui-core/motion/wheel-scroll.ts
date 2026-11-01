export const WHEEL_FRAME_MS = 1000 / 60;
export const WHEEL_MAX_FRAME_MS = 50;
export const WHEEL_GLIDE_MS = 40;

export class WheelScroll {
  private pending = 0;
  private lastStepAt = 0;

  get active(): boolean {
    return this.pending !== 0;
  }

  push(notches: number, now = performance.now()): void {
    if (!Number.isFinite(notches) || notches === 0) return;
    if (Math.sign(notches) !== Math.sign(this.pending)) {
      this.pending = 0;
      this.lastStepAt = now - WHEEL_FRAME_MS;
    }
    this.pending += notches;
  }

  step(now = performance.now()): number {
    if (this.pending === 0) return 0;
    const elapsed = Math.min(WHEEL_MAX_FRAME_MS, Math.max(0, now - this.lastStepAt));
    this.lastStepAt = now;
    const remaining = Math.abs(this.pending);
    const share = 1 - Math.exp(-elapsed / WHEEL_GLIDE_MS);
    const distance = Math.min(remaining, Math.max(1, Math.round(remaining * share)));
    const rows = Math.sign(this.pending) * distance;
    this.pending -= rows;
    return rows;
  }

  take(): number {
    const rows = this.pending;
    this.pending = 0;
    return rows;
  }

  stop(): void {
    this.pending = 0;
  }
}
