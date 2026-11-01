export class WheelScroll {
  private pending = 0;

  get active(): boolean {
    return this.pending !== 0;
  }

  push(notches: number): void {
    if (!Number.isFinite(notches) || notches === 0) return;
    this.pending += notches;
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
