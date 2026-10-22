const MAX_ROWS_PER_FRAME = 2;

export class WheelScroll {
  private pending = 0;

  get active(): boolean {
    return this.pending !== 0;
  }

  push(notches: number): void {
    if (notches === 0) return;
    if (Math.sign(notches) !== Math.sign(this.pending)) this.pending = 0;
    this.pending += notches;
  }

  step(): number {
    const distance = Math.min(MAX_ROWS_PER_FRAME, Math.abs(this.pending));
    const rows = Math.sign(this.pending) * distance;
    this.pending -= rows;
    return rows;
  }

  stop(): void {
    this.pending = 0;
  }
}
