/**
 * App-wide transcript scroll bridge.
 *
 * Wheel/trackpad events often land on the focused composer (or fail hit-test
 * and fall back to it). Those events never bubble into the transcript
 * ScrollBox, so scroll felt like “walking prompt history” instead of moving
 * the chat. TranscriptView registers its native scrollbox here; App +
 * Composer forward every free wheel event to this port.
 *
 * Selection drag uses the same port for edge autoscroll when the pointer
 * leaves the scrollbox (e.g. over the composer) so “select down” keeps moving.
 *
 * Scroll metrics (lines above / below the viewport) feed the status bar badges
 * that classic Ink showed under the input (`▲ N` / `▼ N`).
 */

export interface TranscriptScrollPort {
  /** Scroll the chat by `dy` rows (negative = up). Returns false if unmounted. */
  scrollBy(dy: number): boolean;
  /** OpenTUI ScrollBox edge autoscroll while drag-selecting. */
  updateAutoScroll(x: number, y: number): void;
  stopAutoScroll(): void;
  /** True when the live port is registered. */
  readonly active: boolean;
  /** Latest lines-above / lines-below metrics (classic status badges). */
  readonly metrics: ScrollMetrics;
  /** Subscribe to metric changes; fires immediately with the current value. */
  onMetrics(listener: (metrics: ScrollMetrics) => void): () => void;
}

/** Classic-parity remaining-line counts for the status strip under the input. */
export interface ScrollMetrics {
  /** Rows of transcript above the viewport (scroll further up to read). */
  readonly linesAbove: number;
  /** Rows of transcript below the viewport (scroll further down to catch up). */
  readonly linesBelow: number;
}

export const EMPTY_SCROLL_METRICS: ScrollMetrics = {
  linesAbove: 0,
  linesBelow: 0,
};

type Handler = (dy: number) => void;
type AutoScrollHandler = {
  update(x: number, y: number): void;
  stop(): void;
};

let handler: Handler | undefined;
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

/** TranscriptView calls this on mount; returns an unregister function. */
export function registerTranscriptScrollPort(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

/** Wire ScrollBox start/update/stop auto-scroll for selection edge scroll. */
export function registerTranscriptAutoScroll(next: AutoScrollHandler): () => void {
  autoScroll = next;
  return () => {
    if (autoScroll === next) autoScroll = undefined;
  };
}

/**
 * TranscriptView publishes viewport remainder so the status line can show
 * classic `▲ N` / `▼ N` badges under the composer.
 */
export function publishTranscriptScrollMetrics(next: ScrollMetrics): void {
  publishMetrics({
    linesAbove: Math.max(0, Math.floor(next.linesAbove)),
    linesBelow: Math.max(0, Math.floor(next.linesBelow)),
  });
}
