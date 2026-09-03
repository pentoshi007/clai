import { useMemo, useRef, useSyncExternalStore } from "react";
import type { SessionController, SessionState } from "../../app/controllers/session-controller.js";
import { transcriptFollowKey } from "../state/transcript-follow-key.js";
import type { TranscriptState } from "../state/transcript-types.js";
import type { TranscriptStore } from "../state/transcript-store.js";

export function createFieldSnapshot<TState, TField>(
  getState: () => TState,
  select: (state: TState) => TField,
): () => TField {
  let initialized = false;
  let last: TField | undefined = undefined;
  return (): TField => {
    const next = select(getState());
    if (!initialized || !Object.is(next, last)) {
      initialized = true;
      last = next;
    }
    return last as TField;
  };
}

export function useTranscriptField<TField>(
  store: TranscriptStore,
  select: (state: TranscriptState) => TField,
): TField {
  const selectRef = useRef(select);
  selectRef.current = select;
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useMemo(
    () => createFieldSnapshot(() => store.getState(), (state) => selectRef.current(state)),
    [store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionField<TField>(
  session: SessionController,
  select: (state: SessionState) => TField,
): TField {
  const selectRef = useRef(select);
  selectRef.current = select;
  const subscribe = useMemo(
    () => (listener: () => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useMemo(
    () => createFieldSnapshot(() => session.getState(), (state) => selectRef.current(state)),
    [session],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useTranscriptFollowKeyValue(
  store: TranscriptStore,
  running: boolean,
): string {
  const runningRef = useRef(running);
  runningRef.current = running;
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = useMemo(
    () =>
      createFieldSnapshot(() => store.getState(), (state) =>
        transcriptFollowKey(state, runningRef.current),
      ),
    [store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
