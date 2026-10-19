import type { TranscriptItem } from "../../app/ports/transcript-item.js";
import { flattenTranscriptHistory } from "../../ui-core/state/transcript-history.js";

export function preserveTranscript(
  existing: readonly TranscriptItem[] | undefined,
  incoming: readonly TranscriptItem[] | undefined,
): TranscriptItem[] | undefined {
  if (!existing?.length) return incoming ? [...incoming] : undefined;
  if (!incoming?.length) return [...existing];
  const replacements = new Map(incoming.map((item) => [item.id, item]));
  const merged = existing.map((item) => replacements.get(item.id) ?? item);
  const known = new Set(existing.map((item) => item.id));
  for (const item of incoming) {
    if (!known.has(item.id)) merged.push(item);
  }
  return flattenTranscriptHistory(merged);
}
