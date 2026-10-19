import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { flattenTranscriptHistory } from "../../ui-core/state/transcript-history.js";

function append(groups: Map<string, TranscriptItem[]>, id: string, items: readonly TranscriptItem[]): void {
  const group = groups.get(id);
  if (group) group.push(...items);
  else groups.set(id, [...items]);
}

export function mergeTranscripts(
  winner: readonly TranscriptItem[] | undefined,
  loser: readonly TranscriptItem[] | undefined,
): TranscriptItem[] | undefined {
  if (!winner?.length) return loser ? flattenTranscriptHistory([...loser]) : undefined;
  if (!loser?.length) return [...winner];
  const known = new Set(winner.map((item) => item.id));
  if (loser.every((item) => known.has(item.id))) return [...winner];
  const before = new Map<string, TranscriptItem[]>();
  const after = new Map<string, TranscriptItem[]>();
  let anchor: string | undefined;
  let pending: TranscriptItem[] = [];
  for (const item of loser) {
    if (!known.has(item.id)) {
      pending.push(item);
      continue;
    }
    if (pending.length > 0) {
      if (anchor === undefined) append(before, item.id, pending);
      else append(after, anchor, pending);
      pending = [];
    }
    anchor = item.id;
  }
  if (pending.length > 0 && anchor !== undefined) {
    append(after, anchor, pending);
    pending = [];
  }
  const merged: TranscriptItem[] = [];
  for (const item of winner) {
    merged.push(...(before.get(item.id) ?? []), item, ...(after.get(item.id) ?? []));
  }
  merged.push(...pending);
  return flattenTranscriptHistory(merged);
}
