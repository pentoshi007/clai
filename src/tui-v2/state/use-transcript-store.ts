/**
 * React binding for `TranscriptStore` (V2-050).
 *
 * Isolated to this one file so the store, reducer, and types stay renderer-
 * independent (see `test/tui-v2/architecture.test.ts`); every transcript
 * component reads state through this hook instead of subscribing by hand.
 */

import { useSyncExternalStore } from "react";
import type { TranscriptStore } from "./transcript-store.js";
import type { TranscriptState } from "./transcript-types.js";

export function useTranscriptState(store: TranscriptStore): TranscriptState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
  );
}
