import type { TranscriptItem as PersistedItem } from "../../app/ports/transcript-item.js";
import type { TranscriptItem } from "./transcript-types.js";

type HistoryItem = PersistedItem | TranscriptItem;

export function flattenTranscriptHistory(items: readonly PersistedItem[]): PersistedItem[];
export function flattenTranscriptHistory(items: readonly HistoryItem[]): HistoryItem[];
export function flattenTranscriptHistory(items: readonly HistoryItem[]): HistoryItem[] {
  const roots = new Map(items.map((item) => [item.id, item]));
  const emitted = new Set<string>();
  const visited = new Set<string>();
  const result: HistoryItem[] = [];
  const stack: { item: HistoryItem; emit: boolean; root: boolean }[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    stack.push({ item: items[index]!, emit: false, root: true });
  }
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const item = entry.root ? roots.get(entry.item.id)! : entry.item;
    if (emitted.has(item.id)) continue;
    if (entry.emit) {
      emitted.add(item.id);
      result.push(item.kind === "compacted" && item.originalItems?.length
        ? { ...item, originalItems: [] }
        : item);
      continue;
    }
    if (!entry.root && roots.has(item.id)) continue;
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    stack.push({ ...entry, item, emit: true });
    if (item.kind !== "compacted") continue;
    const originals = item.originalItems ?? [];
    for (let index = originals.length - 1; index >= 0; index -= 1) {
      stack.push({ item: originals[index]!, emit: false, root: false });
    }
  }
  return result;
}
