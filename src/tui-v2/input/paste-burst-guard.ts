import type { KeyEventLike } from "../../ui-core/actions/chord.js";
import {
  PasteBurstDetector,
  type BurstOutput,
  type BurstUnit,
  type PasteBurstOptions,
} from "../../ui-core/input/paste-burst.js";
import { normalizePasteLineBreaks } from "../../ui-core/input/paste-text.js";

export interface GuardedKey extends KeyEventLike {
  readonly sequence: string;
  readonly hyper?: boolean | undefined;
  stopPropagation(): void;
}

export interface GuardedKeyInput<K extends GuardedKey> {
  prependListener(event: "keypress", listener: (key: K) => void): unknown;
  prependListener(event: "paste", listener: () => void): unknown;
  removeListener(event: "keypress", listener: (key: K) => void): unknown;
  removeListener(event: "paste", listener: () => void): unknown;
  processParsedKey(key: K): unknown;
  processPaste(bytes: Uint8Array): unknown;
}

export interface PasteBurstGuardOptions {
  readonly detector?: Omit<PasteBurstOptions, "normalize"> | undefined;
  readonly now?: (() => number) | undefined;
  readonly schedule?: ((callback: () => void, delayMs: number) => () => void) | undefined;
  readonly defer?: ((callback: () => void) => void) | undefined;
}

const PRINTABLE = /^[^\u0000-\u0008\u000a-\u001f\u007f-\u009f]+$/u;

const encoder = new TextEncoder();

function scheduleUnref(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function isModified(key: GuardedKey): boolean {
  return (
    key.ctrl === true ||
    key.meta === true ||
    key.option === true ||
    key.super === true ||
    key.hyper === true
  );
}

function classify<K extends GuardedKey>(key: K): BurstUnit<K> {
  const other: BurstUnit<K> = { kind: "other", text: "", source: key };
  if (key.eventType === "release" || key.source === "kitty" || isModified(key)) return other;
  if (key.name === "tab" && key.sequence === "\t" && key.shift !== true) {
    return { kind: "tab", text: "\t", source: key };
  }
  if (key.name === "return" && key.sequence === "\r" && key.shift !== true) {
    return { kind: "break", text: "\r", source: key };
  }
  if (key.name === "linefeed" && key.sequence === "\n") {
    return { kind: "break", text: "\n", source: key };
  }
  if (PRINTABLE.test(key.sequence)) return { kind: "content", text: key.sequence, source: key };
  return other;
}

export function installPasteBurstGuard<K extends GuardedKey>(
  input: GuardedKeyInput<K>,
  options: PasteBurstGuardOptions = {},
): () => void {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? scheduleUnref;
  const defer = options.defer ?? queueMicrotask;
  const detector = new PasteBurstDetector<K>({
    ...options.detector,
    normalize: normalizePasteLineBreaks,
  });
  let chunk: BurstUnit<K>[] = [];
  let chunkQueued = false;
  let replaying = false;
  let disposed = false;
  let cancelTimer: (() => void) | undefined;

  const whileReplaying = (action: () => void): void => {
    replaying = true;
    try {
      action();
    } finally {
      replaying = false;
    }
  };

  const deliver = (outputs: readonly BurstOutput<K>[], current?: K): void => {
    for (const output of outputs) {
      if (output.type === "paste") {
        whileReplaying(() => input.processPaste(encoder.encode(output.text)));
      } else if (output.source !== current) {
        whileReplaying(() => input.processParsedKey(output.source));
      }
    }
  };

  const rearm = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    const deadline = detector.pendingDeadline;
    if (deadline === undefined || disposed) return;
    cancelTimer = schedule(onDeadline, Math.max(0, deadline - now()));
  };

  const onDeadline = (): void => {
    cancelTimer = undefined;
    deliver(detector.expire(now()));
    rearm();
  };

  const settleChunk = (): void => {
    chunkQueued = false;
    if (chunk.length === 0) return;
    const units = chunk;
    chunk = [];
    deliver(detector.process(units, now()));
    rearm();
  };

  const onKeyPress = (key: K): void => {
    if (replaying) return;
    const unit = classify(key);
    if (unit.kind === "other") {
      settleChunk();
      deliver(detector.process([unit], now()), key);
      rearm();
      return;
    }
    key.stopPropagation();
    chunk.push(unit);
    if (chunkQueued) return;
    chunkQueued = true;
    defer(settleChunk);
  };

  const onPaste = (): void => {
    if (replaying) return;
    settleChunk();
    deliver(detector.flush());
    rearm();
  };

  input.prependListener("keypress", onKeyPress);
  input.prependListener("paste", onPaste);

  return () => {
    if (disposed) return;
    disposed = true;
    input.removeListener("keypress", onKeyPress);
    input.removeListener("paste", onPaste);
    cancelTimer?.();
    cancelTimer = undefined;
    settleChunk();
    deliver(detector.flush());
  };
}
