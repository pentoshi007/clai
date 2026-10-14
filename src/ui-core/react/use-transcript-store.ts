
import { useMemo, useSyncExternalStore } from "react";
import type { TranscriptStore } from "../state/transcript-store.js";
import type { TranscriptState } from "../state/transcript-types.js";

export function useTranscriptState(store: TranscriptStore): TranscriptState {
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useMemo(() => () => store.getState(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
