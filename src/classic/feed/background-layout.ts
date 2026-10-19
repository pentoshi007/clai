import type { FeedBlock } from "./feed-blocks.js";

export interface BackgroundLayoutOptions {
  readonly startDelayMs?: number;
  readonly sliceMs?: number;
  readonly pauseMs?: number;
  readonly now?: () => number;
}

export class BackgroundLayout {
  private blocks: readonly FeedBlock[] = [];
  private cursor = -1;
  private measured = false;
  private onSettled: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly startDelayMs: number;
  private readonly sliceMs: number;
  private readonly pauseMs: number;
  private readonly now: () => number;

  constructor(options: BackgroundLayoutOptions = {}) {
    this.startDelayMs = options.startDelayMs ?? 150;
    this.sliceMs = options.sliceMs ?? 4;
    this.pauseMs = options.pauseMs ?? 12;
    this.now = options.now ?? (() => performance.now());
  }

  get pending(): boolean {
    return this.cursor >= 0;
  }

  schedule(blocks: readonly FeedBlock[], onSettled?: () => void): void {
    if (blocks === this.blocks) return;
    this.blocks = blocks;
    this.onSettled = onSettled;
    this.cursor = blocks.length - 1;
    this.skipMeasured();
    this.cancel();
    if (this.cursor >= 0) this.arm(this.startDelayMs);
  }

  step(): boolean {
    const deadline = this.now() + this.sliceMs;
    while (this.cursor >= 0) {
      this.blocks[this.cursor]!.measure!();
      this.measured = true;
      this.cursor -= 1;
      this.skipMeasured();
      if (this.now() >= deadline) break;
    }
    if (this.cursor >= 0) return false;
    if (this.measured) {
      this.measured = false;
      this.onSettled?.();
    }
    return true;
  }

  dispose(): void {
    this.cancel();
    this.blocks = [];
    this.cursor = -1;
    this.onSettled = undefined;
  }

  private skipMeasured(): void {
    while (this.cursor >= 0) {
      const block = this.blocks[this.cursor]!;
      if (block.layoutPending && block.measure) return;
      this.cursor -= 1;
    }
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.step()) this.arm(this.pauseMs);
    }, delay);
    this.timer.unref?.();
  }
}
