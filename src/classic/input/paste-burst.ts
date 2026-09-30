import type { DecodedEvent, KeyEvent } from "./key-event.js";
import { sanitizePasteText } from "./paste-decoder.js";
import {
  PASTE_BURST_GLUE_MS,
  PASTE_BURST_SETTLE_MS,
} from "./terminal-sequences.js";

export interface PasteBurstOptions {
  readonly glueMs?: number | undefined;
  readonly settleMs?: number | undefined;
}

function unmodified(key: KeyEvent): boolean {
  return !key.ctrl && !key.alt && !key.meta && key.super !== true;
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "enter" && !key.shift && unmodified(key);
}

function isLineFeed(key: KeyEvent): boolean {
  return (
    key.name === "j" &&
    key.ctrl &&
    !key.alt &&
    !key.meta &&
    !key.shift &&
    key.super !== true
  );
}

function isLineBreak(event: DecodedEvent): boolean {
  return event.type === "key" && (isEnter(event.key) || isLineFeed(event.key));
}

function isContent(event: DecodedEvent): boolean {
  return event.type === "key" && unmodified(event.key) && event.key.text.length > 0;
}

function isPlain(events: readonly DecodedEvent[]): boolean {
  return events.every((event) => isContent(event) || isLineBreak(event));
}

function textOf(events: readonly DecodedEvent[]): string {
  let text = "";
  let afterEnter = false;
  for (const event of events) {
    if (event.type !== "key") continue;
    const enter = isEnter(event.key);
    if (enter || (isLineFeed(event.key) && !afterEnter)) text += "\n";
    else if (isContent(event)) text += event.key.text;
    afterEnter = enter;
  }
  return text;
}

function hasLineBreakBeforeContent(events: readonly DecodedEvent[]): boolean {
  let seenBreak = false;
  for (const event of events) {
    if (isLineBreak(event)) seenBreak = true;
    else if (seenBreak && isContent(event)) return true;
  }
  return false;
}

function endsWithLineBreakAfterContent(events: readonly DecodedEvent[]): boolean {
  const last = events.at(-1);
  return (
    last !== undefined && isLineBreak(last) && events.slice(0, -1).some(isContent)
  );
}

export class PasteBurstAssembler {
  private readonly glueMs: number;
  private readonly settleMs: number;
  private collected: string | undefined;
  private held: readonly DecodedEvent[] = [];
  private touchedAt = 0;
  private plainAt = Number.NEGATIVE_INFINITY;

  constructor(options: PasteBurstOptions = {}) {
    this.glueMs = options.glueMs ?? PASTE_BURST_GLUE_MS;
    this.settleMs = options.settleMs ?? PASTE_BURST_SETTLE_MS;
  }

  get pendingDeadline(): number | undefined {
    if (this.collected !== undefined) return this.touchedAt + this.settleMs;
    if (this.held.length > 0) return this.touchedAt + this.glueMs;
    return undefined;
  }

  process(events: readonly DecodedEvent[], now: number): readonly DecodedEvent[] {
    if (events.length === 0) return events;
    const plain = isPlain(events);
    const followsPlainInput = plain && now - this.plainAt <= this.glueMs;
    const emitted: DecodedEvent[] = [];

    if (this.collected !== undefined) {
      if (plain && now - this.touchedAt <= this.settleMs) {
        this.collected += textOf(events);
        this.touch(now);
        return emitted;
      }
      emitted.push(...this.releaseCollected());
    } else if (this.held.length > 0) {
      if (followsPlainInput) {
        this.collected = textOf(this.held) + textOf(events);
        this.held = [];
        this.touch(now);
        return emitted;
      }
      emitted.push(...this.held);
      this.held = [];
    }

    if (!plain) {
      emitted.push(...events);
      return emitted;
    }
    const startsBurst =
      hasLineBreakBeforeContent(events) ||
      (followsPlainInput && events.some(isLineBreak));
    if (startsBurst) {
      this.collected = textOf(events);
      this.touch(now);
      return emitted;
    }
    if (endsWithLineBreakAfterContent(events)) {
      this.held = events;
      this.touch(now);
      return emitted;
    }
    this.plainAt = now;
    emitted.push(...events);
    return emitted;
  }

  expire(now: number): readonly DecodedEvent[] {
    const deadline = this.pendingDeadline;
    if (deadline === undefined || now < deadline) return [];
    if (this.collected !== undefined) return this.releaseCollected();
    const held = this.held;
    this.held = [];
    return held;
  }

  private touch(now: number): void {
    this.touchedAt = now;
    this.plainAt = now;
  }

  private releaseCollected(): readonly DecodedEvent[] {
    const text = sanitizePasteText(this.collected ?? "");
    this.collected = undefined;
    return text.length > 0 ? [{ type: "paste", text }] : [];
  }
}
