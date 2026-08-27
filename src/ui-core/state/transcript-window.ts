export const DEFAULT_TRANSCRIPT_MOUNT_ROWS = 320;
export const DEFAULT_TRANSCRIPT_WINDOW_OVERLAP = 64;

export interface TranscriptMountWindow {
  readonly start: number;
  readonly end: number;
  readonly olderCount: number;
  readonly newerCount: number;
}

export function resolveTranscriptMountWindow(
  totalItems: number,
  requestedStart: number | undefined,
  size = DEFAULT_TRANSCRIPT_MOUNT_ROWS,
): TranscriptMountWindow {
  const total = Math.max(0, Math.floor(totalItems));
  const windowSize = Math.max(1, Math.floor(size));
  const maxStart = Math.max(0, total - windowSize);
  const start =
    requestedStart === undefined
      ? maxStart
      : Math.max(0, Math.min(maxStart, Math.floor(requestedStart)));
  const end = Math.min(total, start + windowSize);
  return {
    start,
    end,
    olderCount: start,
    newerCount: Math.max(0, total - end),
  };
}

export function transcriptWindowStartForItem(
  totalItems: number,
  itemIndex: number,
  size = DEFAULT_TRANSCRIPT_MOUNT_ROWS,
): number {
  const total = Math.max(0, Math.floor(totalItems));
  if (total === 0) return 0;
  const windowSize = Math.max(1, Math.floor(size));
  const index = Math.max(0, Math.min(total - 1, Math.floor(itemIndex)));
  return Math.max(
    0,
    Math.min(total - windowSize, index - Math.floor(windowSize / 2)),
  );
}

export function shiftTranscriptWindowStart(
  totalItems: number,
  currentStart: number,
  direction: "older" | "newer",
  size = DEFAULT_TRANSCRIPT_MOUNT_ROWS,
  overlap = DEFAULT_TRANSCRIPT_WINDOW_OVERLAP,
): number {
  const windowSize = Math.max(1, Math.floor(size));
  const retained = Math.max(
    0,
    Math.min(windowSize - 1, Math.floor(overlap)),
  );
  const step = Math.max(1, windowSize - retained);
  const delta = direction === "older" ? -step : step;
  return resolveTranscriptMountWindow(
    totalItems,
    currentStart + delta,
    windowSize,
  ).start;
}

export interface TranscriptScrollIntent {
  readonly nextScrollTop: number;
  readonly leaveTail: boolean;
  readonly reachedOlderEdge: boolean;
  readonly reachedNewerEdge: boolean;
  readonly atBottom: boolean;
}

export function resolveTranscriptScrollIntent(
  scrollTop: number,
  maxScrollTop: number,
  delta: number,
): TranscriptScrollIntent {
  const max = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
  const current = Number.isFinite(scrollTop)
    ? Math.max(0, Math.min(max, scrollTop))
    : 0;
  const movement = Number.isFinite(delta) ? delta : 0;
  const next = Math.max(0, Math.min(max, current + movement));
  return {
    nextScrollTop: next,
    leaveTail: movement < 0,
    reachedOlderEdge: movement < 0 && next === 0,
    reachedNewerEdge: movement > 0 && next === max,
    atBottom: next === max,
  };
}

/**
 * Whether a queued bottom-pin may run this frame.
 *
 * Automatic pins (content growth) must not yank the viewport while a pointer
 * gesture is in flight, but an explicit End / Ctrl+D is a direct command and
 * outranks it — including when a press was released outside the transcript and
 * left the gesture flag set.
 */
export function shouldPinTranscriptBottom(input: {
  readonly following: boolean;
  readonly pointerGestureActive: boolean;
  readonly forced: boolean;
}): boolean {
  if (!input.following) return false;
  if (input.forced) return true;
  return !input.pointerGestureActive;
}
