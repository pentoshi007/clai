
import { WheelScroll } from "../../../ui-core/motion/wheel-scroll.js";

export interface TranscriptScrollPort {
  scrollBy(dy: number): boolean;
  wheel(notches: number): boolean;
  stopWheel(): void;
  scrollToTop(): boolean;
  scrollToBottom(): boolean;
  updateAutoScroll(x: number, y: number): void;
  stopAutoScroll(): void;
  readonly active: boolean;
  readonly metrics: ScrollMetrics;
  onMetrics(listener: (metrics: ScrollMetrics) => void): () => void;
}

export interface ScrollMetrics {
  readonly linesAbove: number;
  readonly linesBelow: number;
  readonly hasNewerContent?: boolean;
}

export const EMPTY_SCROLL_METRICS: ScrollMetrics = {
  linesAbove: 0,
  linesBelow: 0,
};

interface WheelFrameScheduler {
  requestRender(): void;
  setFrameCallback(callback: () => Promise<void>): void;
  removeFrameCallback(callback: () => Promise<void>): void;
}

type Handler = (dy: number) => void;
type JumpHandler = () => void;
type AutoScrollHandler = {
  update(x: number, y: number): void;
  stop(): void;
};

let handler: Handler | undefined;
let topHandler: JumpHandler | undefined;
let bottomHandler: JumpHandler | undefined;
let autoScroll: AutoScrollHandler | undefined;
let metrics: ScrollMetrics = EMPTY_SCROLL_METRICS;
const metricListeners = new Set<(m: ScrollMetrics) => void>();
const wheelInput = new WheelScroll();
let wheelFlushQueued = false;
let wheelScheduler: WheelFrameScheduler | undefined;

function flushWheel(): void {
  wheelFlushQueued = false;
  const rows = wheelInput.take();
  if (rows !== 0) handler?.(rows);
}

function stopWheel(): void {
  wheelInput.stop();
  wheelFlushQueued = false;
}

function requestWheelFlush(): void {
  if (wheelFlushQueued) return;
  wheelFlushQueued = true;
  if (wheelScheduler) wheelScheduler.requestRender();
  else queueMicrotask(() => { if (!wheelScheduler) flushWheel(); });
}

function publishMetrics(next: ScrollMetrics): void {
  if (
    next.linesAbove === metrics.linesAbove &&
    next.linesBelow === metrics.linesBelow &&
    Boolean(next.hasNewerContent) === Boolean(metrics.hasNewerContent)
  ) {
    return;
  }
  metrics = next;
  for (const listener of metricListeners) listener(metrics);
}

export const transcriptScrollPort: TranscriptScrollPort = {
  get active() {
    return handler !== undefined;
  },
  get metrics() {
    return metrics;
  },
  scrollBy(dy: number): boolean {
    if (!handler || dy === 0) return false;
    stopWheel();
    handler(dy);
    return true;
  },
  wheel(notches: number): boolean {
    if (!handler || !Number.isFinite(notches) || notches === 0) return false;
    wheelInput.push(notches);
    requestWheelFlush();
    return true;
  },
  stopWheel,
  scrollToTop(): boolean {
    if (!topHandler) return false;
    stopWheel();
    topHandler();
    return true;
  },
  scrollToBottom(): boolean {
    if (!bottomHandler) return false;
    stopWheel();
    bottomHandler();
    return true;
  },
  updateAutoScroll(x: number, y: number): void {
    autoScroll?.update(x, y);
  },
  stopAutoScroll(): void {
    autoScroll?.stop();
  },
  onMetrics(listener: (m: ScrollMetrics) => void): () => void {
    metricListeners.add(listener);
    listener(metrics);
    return () => {
      metricListeners.delete(listener);
    };
  },
};

export function registerTranscriptScrollPort(
  next: Handler,
  scheduler?: WheelFrameScheduler,
): () => void {
  handler = next;
  wheelScheduler = scheduler;
  const beforeFrame = async (): Promise<void> => {
    if (handler === next && wheelScheduler === scheduler) flushWheel();
  };
  scheduler?.setFrameCallback(beforeFrame);
  if (wheelInput.active) {
    wheelFlushQueued = false;
    requestWheelFlush();
  }
  return () => {
    scheduler?.removeFrameCallback(beforeFrame);
    if (handler !== next) return;
    handler = undefined;
    wheelScheduler = undefined;
    queueMicrotask(() => { if (!handler) stopWheel(); });
  };
}

export function registerTranscriptJumpHandlers(
  top: JumpHandler,
  bottom: JumpHandler,
): () => void {
  topHandler = top;
  bottomHandler = bottom;
  return () => {
    if (topHandler === top) topHandler = undefined;
    if (bottomHandler === bottom) bottomHandler = undefined;
  };
}

export function registerTranscriptAutoScroll(next: AutoScrollHandler): () => void {
  autoScroll = next;
  return () => {
    if (autoScroll === next) autoScroll = undefined;
  };
}

export function publishTranscriptScrollMetrics(next: ScrollMetrics): void {
  publishMetrics({
    linesAbove: Math.max(0, Math.floor(next.linesAbove)),
    linesBelow: Math.max(0, Math.floor(next.linesBelow)),
    ...(next.hasNewerContent ? { hasNewerContent: true } : {}),
  });
}
