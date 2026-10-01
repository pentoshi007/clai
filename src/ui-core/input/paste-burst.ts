export const PASTE_BURST_GLUE_MS = 30;
export const PASTE_BURST_SETTLE_MS = 250;
export const PASTE_BURST_MIN_CHARS = 3;

export type BurstUnitKind = "content" | "break" | "other";

export interface BurstUnit<T> {
  readonly kind: BurstUnitKind;
  readonly text: string;
  readonly source: T;
}

export type BurstOutput<T> =
  | { readonly type: "event"; readonly source: T }
  | { readonly type: "paste"; readonly text: string };

export interface PasteBurstOptions {
  readonly glueMs?: number | undefined;
  readonly settleMs?: number | undefined;
  readonly minChars?: number | undefined;
  readonly normalize?: ((text: string) => string) | undefined;
}

interface ChunkShape {
  readonly breaks: number;
  readonly contentChars: number;
  readonly breakBetweenContent: boolean;
  readonly endsWithBreakAfterContent: boolean;
}

function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function measure<T>(chunk: readonly BurstUnit<T>[]): ChunkShape {
  let breaks = 0;
  let contentChars = 0;
  let contentSeen = false;
  let breakAfterContent = false;
  let breakBetweenContent = false;
  let previousWasCarriageReturn = false;
  for (const unit of chunk) {
    if (unit.kind === "break") {
      if (!(previousWasCarriageReturn && unit.text === "\n")) breaks += 1;
      previousWasCarriageReturn = unit.text === "\r";
      breakAfterContent ||= contentSeen;
      continue;
    }
    previousWasCarriageReturn = false;
    contentChars += countCodePoints(unit.text);
    if (breakAfterContent) breakBetweenContent = true;
    contentSeen = true;
  }
  const last = chunk.at(-1);
  return {
    breaks,
    contentChars,
    breakBetweenContent,
    endsWithBreakAfterContent: last?.kind === "break" && contentSeen,
  };
}

function isContent<T>(unit: BurstUnit<T>): boolean {
  return unit.kind === "content";
}

function textOf<T>(units: readonly BurstUnit<T>[]): string {
  let text = "";
  for (const unit of units) text += unit.text;
  return text;
}

function passThrough<T>(units: readonly BurstUnit<T>[]): BurstOutput<T>[] {
  return units.map((unit) => ({ type: "event", source: unit.source }));
}

export class PasteBurstDetector<T> {
  private readonly glueMs: number;
  private readonly settleMs: number;
  private readonly minChars: number;
  private readonly normalize: (text: string) => string;
  private collected: string | undefined;
  private held: readonly BurstUnit<T>[] = [];
  private touchedAt = 0;
  private plainAt = Number.NEGATIVE_INFINITY;
  private plainWasBulk = false;

  constructor(options: PasteBurstOptions = {}) {
    this.glueMs = options.glueMs ?? PASTE_BURST_GLUE_MS;
    this.settleMs = options.settleMs ?? PASTE_BURST_SETTLE_MS;
    this.minChars = options.minChars ?? PASTE_BURST_MIN_CHARS;
    this.normalize = options.normalize ?? ((text) => text);
  }

  get pendingDeadline(): number | undefined {
    if (this.collected !== undefined) return this.touchedAt + this.settleMs;
    if (this.held.length > 0) return this.touchedAt + this.settleMs;
    return undefined;
  }

  process(chunk: readonly BurstUnit<T>[], now: number): readonly BurstOutput<T>[] {
    if (chunk.length === 0) return [];
    const plain = chunk.every((unit) => unit.kind !== "other");
    const emitted: BurstOutput<T>[] = [];

    if (this.collected !== undefined) {
      if (plain && now - this.touchedAt <= this.settleMs) {
        this.collected += textOf(chunk);
        this.touch(now);
        return emitted;
      }
      emitted.push(...this.releaseCollected());
    } else if (this.held.length > 0) {
      if (plain && this.continuesHeld(chunk, now)) {
        const text = textOf(this.held) + textOf(chunk);
        this.held = [];
        this.begin(text, now);
        return emitted;
      }
      emitted.push(...this.releaseHeld());
    }

    if (!plain) {
      this.plainWasBulk = false;
      emitted.push(...passThrough(chunk));
      return emitted;
    }

    const shape = measure(chunk);
    if (shape.breaks > 0) {
      if (this.startsBurst(shape, now)) {
        this.begin(textOf(chunk), now);
        return emitted;
      }
      if (this.isUndecided(shape, now)) {
        this.held = chunk;
        this.touch(now);
        return emitted;
      }
    }
    this.plainAt = now;
    this.plainWasBulk = shape.contentChars >= this.minChars;
    emitted.push(...passThrough(chunk));
    return emitted;
  }

  expire(now: number): readonly BurstOutput<T>[] {
    const deadline = this.pendingDeadline;
    if (deadline === undefined || now < deadline) return [];
    return this.flush();
  }

  flush(): readonly BurstOutput<T>[] {
    if (this.collected !== undefined) return this.releaseCollected();
    return this.releaseHeld();
  }

  private startsBurst(shape: ChunkShape, now: number): boolean {
    if (shape.breakBetweenContent) return true;
    const followsBulkInput = shape.contentChars > 0 && this.plainWasBulk;
    const gapLimit = followsBulkInput ? this.settleMs : this.glueMs;
    return now - this.plainAt <= gapLimit;
  }

  private continuesHeld(chunk: readonly BurstUnit<T>[], now: number): boolean {
    const gap = now - this.touchedAt;
    if (gap > this.settleMs) return false;
    if (this.held.some(isContent)) return true;
    return gap <= this.glueMs || chunk.some(isContent);
  }

  private isUndecided(shape: ChunkShape, now: number): boolean {
    if (shape.endsWithBreakAfterContent) return true;
    return this.plainWasBulk && now - this.plainAt <= this.settleMs;
  }

  private begin(text: string, now: number): void {
    this.collected = text;
    this.touch(now);
  }

  private touch(now: number): void {
    this.touchedAt = now;
    this.plainAt = now;
    this.plainWasBulk = true;
  }

  private releaseCollected(): readonly BurstOutput<T>[] {
    const text = this.normalize(this.collected ?? "");
    this.collected = undefined;
    return text.length > 0 ? [{ type: "paste", text }] : [];
  }

  private releaseHeld(): readonly BurstOutput<T>[] {
    const held = this.held;
    this.held = [];
    this.plainWasBulk = false;
    return passThrough(held);
  }
}
