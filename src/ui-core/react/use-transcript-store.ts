
import { useSyncExternalStore } from "react";
import type { TranscriptStore } from "../state/transcript-store.js";
import type { TranscriptState } from "../state/transcript-types.js";

export function useTranscriptState(store: TranscriptStore): TranscriptState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
  );
}
