/**
 * Single-line stderr spinner for the non-interactive surface (06-ONESHOT §3).
 *
 * Active only when `err` is a TTY. The line is rewritten with `\r` and cleared
 * with `\r\x1b[K` before any other write, so stdout and stderr never interleave
 * mid-line. `clear()` is safe to call when inactive or already cleared.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII_FRAMES = ["-", "\\", "|", "/"] as const;

export interface StreamSpinnerOptions {
  readonly err: NodeJS.WritableStream & { isTTY?: boolean | undefined };
  readonly columns: number;
  readonly unicode: boolean;
  readonly enabled?: boolean | undefined;
}

export class StreamSpinner {
  private readonly frames: readonly string[];
  private readonly active: boolean;
  private frame = 0;
  private label = "";
  private painted = false;

  constructor(private readonly options: StreamSpinnerOptions) {
    this.frames = options.unicode ? FRAMES : ASCII_FRAMES;
    this.active = (options.enabled ?? true) && options.err.isTTY === true;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Paint (or repaint) the status line; a new label advances the frame. */
  tick(label: string): void {
    if (!this.active) return;
    if (this.painted && label !== this.label) {
      this.frame = (this.frame + 1) % this.frames.length;
    }
    this.label = label;
    const max = Math.max(8, this.options.columns - 1);
    const text = `${this.frames[this.frame]} ${label}`.slice(0, max);
    this.options.err.write(`\r\x1b[K${text}`);
    this.painted = true;
  }

  clear(): void {
    if (!this.active || !this.painted) return;
    this.painted = false;
    this.options.err.write("\r\x1b[K");
  }
}
