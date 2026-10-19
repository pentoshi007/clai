import type { OutputSpool } from "../../app/events/event-buffer.js";
import type { TranscriptItem as PersistedTranscriptItem } from "../../app/ports/transcript-item.js";
import { mergeTranscripts } from "../../store/history/transcript-merge.js";
import { hydrateFromClassicTranscript } from "../state/transcript-hydrate.js";
import { flattenTranscriptHistory } from "../state/transcript-history.js";
import type { TranscriptStore } from "../state/transcript-store.js";
import { restoreArtifactOutputs } from "./session-resume.js";

export function absorbPersistedTranscript(
  transcript: TranscriptStore,
  spool: Pick<OutputSpool, "replace" | "defer">,
  current: readonly PersistedTranscriptItem[],
  incoming: readonly PersistedTranscriptItem[],
): PersistedTranscriptItem[] {
  const known = flattenTranscriptHistory(current);
  const ids = new Set(known.map((item) => item.id));
  const added = flattenTranscriptHistory(incoming).filter((item) => !ids.has(item.id));
  if (added.length === 0) return [];
  const merged = mergeTranscripts(known, incoming) ?? known;
  const hydrated = hydrateFromClassicTranscript(added);
  transcript.insertPersisted(merged.map((item) => item.id), hydrated.state.byId, merged);
  for (const [toolCallId, output] of hydrated.toolOutputs) spool.replace(toolCallId, output);
  restoreArtifactOutputs(hydrated.state, spool);
  return added;
}
