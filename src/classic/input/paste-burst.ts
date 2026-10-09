import {
  PasteBurstDetector,
  type BurstOutput,
  type BurstUnit,
  type PasteBurstOptions as DetectorOptions,
} from "../../ui-core/input/paste-burst.js";
import type { DecodedEvent, KeyEvent } from "./key-event.js";
import { sanitizePasteText } from "./paste-decoder.js";

export type PasteBurstOptions = Omit<DetectorOptions, "normalize">;

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

function unitOf(event: DecodedEvent): BurstUnit<DecodedEvent> {
  if (event.type === "text") return { kind: "content", text: event.text, source: event };
  if (event.type === "key") {
    const { key } = event;
    if (isEnter(key)) return { kind: "break", text: "\r", source: event };
    if (isLineFeed(key)) return { kind: "break", text: "\n", source: event };
    if (unmodified(key) && key.text.length > 0) {
      return { kind: "content", text: key.text, source: event };
    }
  }
  return { kind: "other", text: "", source: event };
}

function eventOf(output: BurstOutput<DecodedEvent>): DecodedEvent {
  return output.type === "paste" ? { type: "paste", text: output.text } : output.source;
}

export class PasteBurstAssembler {
  private readonly detector: PasteBurstDetector<DecodedEvent>;

  constructor(options: PasteBurstOptions = {}) {
    this.detector = new PasteBurstDetector({ ...options, normalize: sanitizePasteText });
  }

  get pendingDeadline(): number | undefined {
    return this.detector.pendingDeadline;
  }

  process(events: readonly DecodedEvent[], now: number): readonly DecodedEvent[] {
    if (events.length === 0) return events;
    return this.detector.process(events.map(unitOf), now).map(eventOf);
  }

  expire(now: number): readonly DecodedEvent[] {
    return this.detector.expire(now).map(eventOf);
  }
}
