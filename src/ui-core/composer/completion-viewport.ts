export interface CompletionViewportBounds {
  readonly itemCount: number;
  readonly maxRows: number;
}

export interface CompletionViewportState {
  readonly offset: number;
  readonly selected: number;
  readonly hovered: number | undefined;
}

export type CompletionViewportAction =
  | { readonly type: "reset"; readonly selected?: number | undefined }
  | { readonly type: "reconcile"; readonly selected?: number | undefined }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "hover"; readonly index: number | undefined }
  | { readonly type: "scroll"; readonly rows: number };

export interface CompletionViewportWindow {
  readonly start: number;
  readonly end: number;
  readonly visibleCount: number;
  readonly before: number;
  readonly after: number;
}

function normalizedItemCount(itemCount: number): number {
  return Math.max(0, Math.floor(Number.isFinite(itemCount) ? itemCount : 0));
}

export function completionVisibleCount(itemCount: number, maxRows: number): number {
  const count = normalizedItemCount(itemCount);
  if (count === 0) return 0;
  const rows = Math.max(1, Math.floor(Number.isFinite(maxRows) ? maxRows : 1));
  return Math.min(count, rows);
}

export function clampCompletionViewport(
  offset: number,
  itemCount: number,
  maxRows: number,
): number {
  const count = normalizedItemCount(itemCount);
  const visibleCount = completionVisibleCount(count, maxRows);
  const maxOffset = Math.max(0, count - visibleCount);
  const value = Math.floor(Number.isFinite(offset) ? offset : 0);
  return Math.max(0, Math.min(maxOffset, value));
}

function clampSelection(index: number, itemCount: number): number {
  const count = normalizedItemCount(itemCount);
  if (count === 0) return 0;
  const value = Math.floor(Number.isFinite(index) ? index : 0);
  return Math.max(0, Math.min(count - 1, value));
}

export function keepCompletionSelectionVisible(
  offset: number,
  selected: number,
  itemCount: number,
  maxRows: number,
): number {
  const count = normalizedItemCount(itemCount);
  const visibleCount = completionVisibleCount(count, maxRows);
  if (visibleCount === 0) return 0;
  const safeSelected = clampSelection(selected, count);
  const safeOffset = clampCompletionViewport(offset, count, maxRows);
  if (safeSelected < safeOffset) return safeSelected;
  if (safeSelected >= safeOffset + visibleCount) {
    return safeSelected - visibleCount + 1;
  }
  return safeOffset;
}

export function completionViewportWindow(
  itemCount: number,
  maxRows: number,
  offset: number,
): CompletionViewportWindow {
  const count = normalizedItemCount(itemCount);
  const visibleCount = completionVisibleCount(count, maxRows);
  const start = clampCompletionViewport(offset, count, maxRows);
  const end = Math.min(count, start + visibleCount);
  return {
    start,
    end,
    visibleCount,
    before: start,
    after: Math.max(0, count - end),
  };
}

export function completionAbsoluteIndex(
  itemCount: number,
  maxRows: number,
  offset: number,
  visibleIndex: number,
): number | undefined {
  const window = completionViewportWindow(itemCount, maxRows, offset);
  const local = Math.floor(Number.isFinite(visibleIndex) ? visibleIndex : -1);
  if (local < 0 || local >= window.end - window.start) return undefined;
  return window.start + local;
}

export function completionWheelRows(direction: string, delta: number): number {
  const magnitude = Math.max(1, Math.ceil(Math.abs(Number.isFinite(delta) ? delta : 1)));
  if (direction === "up" || direction === "left") return -magnitude;
  if (direction === "down" || direction === "right") return magnitude;
  return 0;
}

export function initialCompletionViewportState(): CompletionViewportState {
  return { offset: 0, selected: 0, hovered: undefined };
}

export function reduceCompletionViewport(
  state: CompletionViewportState,
  action: CompletionViewportAction,
  bounds: CompletionViewportBounds,
): CompletionViewportState {
  const itemCount = normalizedItemCount(bounds.itemCount);
  const maxRows = bounds.maxRows;
  if (itemCount === 0) return initialCompletionViewportState();

  if (action.type === "reset") {
    const selected = clampSelection(action.selected ?? 0, itemCount);
    return {
      offset: keepCompletionSelectionVisible(0, selected, itemCount, maxRows),
      selected,
      hovered: undefined,
    };
  }

  if (action.type === "reconcile") {
    const selected = clampSelection(action.selected ?? state.selected, itemCount);
    const offset = keepCompletionSelectionVisible(
      state.offset,
      selected,
      itemCount,
      maxRows,
    );
    return { offset, selected, hovered: undefined };
  }

  if (action.type === "select") {
    const selected = clampSelection(action.index, itemCount);
    const offset = keepCompletionSelectionVisible(
      state.offset,
      selected,
      itemCount,
      maxRows,
    );
    return { offset, selected, hovered: undefined };
  }

  if (action.type === "hover") {
    const hovered =
      action.index === undefined
        ? undefined
        : clampSelection(action.index, itemCount);
    return { ...state, hovered };
  }

  return {
    offset: clampCompletionViewport(
      state.offset + action.rows,
      itemCount,
      maxRows,
    ),
    selected: clampSelection(state.selected, itemCount),
    hovered: undefined,
  };
}
