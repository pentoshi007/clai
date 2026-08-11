import type { TranscriptItem, TranscriptState } from "./transcript-types.js";

export function appendItem(
  state: TranscriptState,
  item: TranscriptItem,
): TranscriptState {
  const byId = new Map(state.byId);
  byId.set(item.id, item);
  return {
    ...state,
    order: [...state.order, item.id],
    byId,
  };
}

export function updateItem(
  state: TranscriptState,
  id: string,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptState {
  const existing = state.byId.get(id);
  if (!existing) return state;
  const byId = new Map(state.byId);
  byId.set(id, update(existing));
  return { ...state, byId };
}

export function removeItem(
  state: TranscriptState,
  id: string,
): TranscriptState {
  if (!state.byId.has(id)) return state;
  const byId = new Map(state.byId);
  byId.delete(id);
  return {
    ...state,
    byId,
    order: state.order.filter((entry) => entry !== id),
  };
}

export function moveItemBefore(
  state: TranscriptState,
  itemId: string,
  beforeId: string,
): TranscriptState {
  if (itemId === beforeId) return state;
  const from = state.order.indexOf(itemId);
  const to = state.order.indexOf(beforeId);
  if (from < 0 || to < 0 || from < to) return state;
  const order = state.order.slice();
  order.splice(from, 1);
  const insertAt = order.indexOf(beforeId);
  if (insertAt < 0) return state;
  order.splice(insertAt, 0, itemId);
  return { ...state, order };
}
