
export interface TranscriptScrollPort {
  scrollBy(dy: number): boolean;
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
}

export const EMPTY_SCROLL_METRICS: ScrollMetrics = {
  linesAbove: 0,
  linesBelow: 0,
};

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

function publishMetrics(next: ScrollMetrics): void {
  if (
    next.linesAbove === metrics.linesAbove &&
    next.linesBelow === metrics.linesBelow
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
    handler(dy);
    return true;
  },
  scrollToTop(): boolean {
    if (!topHandler) return false;
    topHandler();
    return true;
  },
  scrollToBottom(): boolean {
    if (!bottomHandler) return false;
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

export function registerTranscriptScrollPort(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
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
  });
}
