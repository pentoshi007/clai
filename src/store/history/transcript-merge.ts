import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { flattenTranscriptHistory } from "../../ui-core/state/transcript-history.js";

function hasCompaction(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.kind === "compacted");
}

export function mergeTranscripts(
  winner: readonly TranscriptItem[] | undefined,
  loser: readonly TranscriptItem[] | undefined,
): TranscriptItem[] | undefined {
  if (!winner?.length) return loser ? flattenTranscriptHistory([...loser]) : undefined;
  if (!loser?.length) return [...winner];
  if (hasCompaction(winner)) return [...winner];
  const known = new Set(winner.map((item) => item.id));
  const appended = loser.filter((item) => !known.has(item.id));
  if (appended.length === 0) return [...winner];
  return flattenTranscriptHistory([...winner, ...appended]);
}
