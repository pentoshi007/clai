
import type { AnyAppEvent } from "../../app/events/app-event.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../app/ports/transcript-item.js";
import {
  applyAppEvent,
  TranscriptSequenceError,
} from "./transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  isItemExpanded,
  type TranscriptState,
} from "./transcript-types.js";

export type TranscriptListener = () => void;

export class TranscriptStore {
  private state: TranscriptState = EMPTY_TRANSCRIPT_STATE;
  private readonly listeners = new Set<TranscriptListener>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyPending = false;
  private persistBase: readonly ClassicTranscriptItem[] = [];
  private persistHydratedIds = new Set<string>();
  private pendingEvents: AnyAppEvent[] = [];
  private contentSource: TranscriptStore | undefined;
  private contentSnapshot: TranscriptState | undefined;

  private static readonly COALESCED_EVENT_TYPES = new Set<string>([
    "assistant-delta",
    "thinking-delta",
    "tool-output",
    "compaction-delta",
  ]);

  private static readonly MAX_PENDING_EVENTS = 512;

  constructor(
    private readonly maxItems = Number.POSITIVE_INFINITY,
    private readonly coalesceMs = 16,
  ) {
    if (!(Number.isInteger(maxItems) || maxItems === Number.POSITIVE_INFINITY) || maxItems <= 0) {
      throw new RangeError("maxItems must be positive");
    }
  }

  getState(): TranscriptState {
    if (this.contentSource) this.syncContent(this.contentSource.getState());
    this.flushPendingEvents();
    return this.state;
  }

  fork(): { readonly transcript: TranscriptStore; dispose(): void } {
    const transcript = new TranscriptStore(this.maxItems, this.coalesceMs);
    transcript.contentSource = this;
    transcript.contentSnapshot = this.getState();
    transcript.state = { ...transcript.contentSnapshot, itemOverrides: new Map(), fileDiffOverrides: new Map(), focusedThinkingId: undefined };
    const unsubscribe = this.subscribe(() => {
      transcript.syncContent(this.getState());
      transcript.flushNotify();
    });
    return {
      transcript,
      dispose() {
        unsubscribe();
        transcript.clearPendingEvents();
        transcript.listeners.clear();
        transcript.contentSource = undefined;
        transcript.contentSnapshot = undefined;
      },
    };
  }

  private syncContent(shared: TranscriptState): void {
    if (this.contentSnapshot === shared) return;
    this.contentSnapshot = shared;
    const local = this.state;
    this.applyState(shared === EMPTY_TRANSCRIPT_STATE ? shared : {
      ...shared,
      expandThinkingGlobal: local.expandThinkingGlobal,
      expandOutputGlobal: local.expandOutputGlobal,
      expandFileDiffsGlobal: local.expandFileDiffsGlobal,
      itemOverrides: local.itemOverrides,
      fileDiffOverrides: local.fileDiffOverrides,
      focusedThinkingId: local.focusedThinkingId && shared.byId.has(local.focusedThinkingId) ? local.focusedThinkingId : undefined,
    });
  }

  dispatch(event: AnyAppEvent): void {
    if (this.contentSource) { this.contentSource.dispatch(event); return; }
    if (TranscriptStore.COALESCED_EVENT_TYPES.has(event.type)) {
      const lastQueuedSequence =
        this.pendingEvents.at(-1)?.sequence ?? this.state.lastSequence;
      if (event.sequence <= lastQueuedSequence) return;
      if (event.sequence > lastQueuedSequence + 1) {
        throw new TranscriptSequenceError(
          lastQueuedSequence + 1,
          event.sequence,
        );
      }
      this.pendingEvents.push(event);
      this.notifyPending = true;
      if (
        this.pendingEvents.length >= TranscriptStore.MAX_PENDING_EVENTS
      ) {
        this.flushPendingEvents();
      }
      this.scheduleNotify();
      return;
    }
    const pendingChanged = this.flushPendingEvents();
    const changed = this.applyState(applyAppEvent(this.state, event));
    if (pendingChanged || changed) this.flushNotify();
  }

  toggleThinkingGlobal(): void {
    const state = this.getState();
    const thinkingItems = state.order
      .map((id) => state.byId.get(id))
      .filter((item) => item?.kind === "thinking");
    const expandThinkingGlobal = thinkingItems.length > 0
      ? !thinkingItems.every((item) => isItemExpanded(state, item))
      : !state.expandThinkingGlobal;
    const itemOverrides = new Map(state.itemOverrides);
    for (const item of thinkingItems) itemOverrides.delete(item.id);
    this.setState({
      ...state,
      expandThinkingGlobal,
      itemOverrides,
      focusedThinkingId: undefined,
    });
  }

  toggleThinkingItem(id: string, fallback: boolean): void {
    const state = this.getState();
    const overrides = new Map(state.itemOverrides);
    const expanded = !(overrides.get(id) ?? fallback);
    overrides.set(id, expanded);
    this.setState({
      ...state,
      itemOverrides: overrides,
      focusedThinkingId: expanded ? id : undefined,
    });
  }

  focusThinking(id: string): void {
    const state = this.getState();
    if (state.focusedThinkingId === id) return;
    this.setState({ ...state, focusedThinkingId: id });
  }

  blurThinking(): void {
    const state = this.getState();
    if (state.focusedThinkingId === undefined) return;
    this.setState({ ...state, focusedThinkingId: undefined });
  }

  toggleOutputGlobal(): void {
    const state = this.getState();
    this.setState({
      ...state,
      expandOutputGlobal: !state.expandOutputGlobal,
    });
  }

  setOutputGlobal(expanded: boolean): void {
    const state = this.getState();
    const overrides = new Map(state.itemOverrides);
    for (const id of [...overrides.keys()]) {
      const item = state.byId.get(id);
      if (item && (item.kind === "tool" || item.kind === "compacted")) {
        overrides.delete(id);
      }
    }
    this.setState({
      ...state,
      expandOutputGlobal: expanded,
      itemOverrides: overrides,
    });
  }

  setFileDiffsGlobal(expanded: boolean): void {
    const state = this.getState();
    this.setState({
      ...state,
      expandFileDiffsGlobal: expanded,
      fileDiffOverrides: new Map(),
    });
  }

  toggleFileDiffsGlobal(): void {
    const state = this.getState();
    this.setFileDiffsGlobal(!state.expandFileDiffsGlobal);
  }

  toggleFileDiffOverride(toolItemId: string, fallback: boolean): void {
    const state = this.getState();
    const overrides = new Map(state.fileDiffOverrides);
    const current = overrides.get(toolItemId) ?? fallback;
    overrides.set(toolItemId, !current);
    this.setState({ ...state, fileDiffOverrides: overrides });
  }

  toggleItemOverride(id: string, fallback: boolean): void {
    const state = this.getState();
    const overrides = new Map(state.itemOverrides);
    const current = overrides.get(id) ?? fallback;
    overrides.set(id, !current);
    this.setState({ ...state, itemOverrides: overrides });
  }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    if (this.contentSource) { this.contentSource.reset(); return; }
    this.clearPendingEvents();
    this.persistBase = [];
    this.persistHydratedIds = new Set();
    this.setState(EMPTY_TRANSCRIPT_STATE);
  }

  hydrate(
    next: TranscriptState,
    options?:
      | {
          readonly rebaseSequence?: boolean;
          readonly persistBase?: readonly ClassicTranscriptItem[] | undefined;
        }
      | undefined,
  ): void {
    if (this.contentSource) { this.contentSource.hydrate(next, options); return; }
    const current = this.getState();
    if (options && "persistBase" in options) {
      this.persistBase = options.persistBase ?? [];
      this.persistHydratedIds = new Set(next.order);
    }
    const rebase = options?.rebaseSequence !== false;
    this.setState({
      ...next,
      ...(rebase
        ? {}
        : { lastSequence: Math.max(current.lastSequence, next.lastSequence) }),
      expandThinkingGlobal: current.expandThinkingGlobal,
      expandOutputGlobal: current.expandOutputGlobal,
      expandFileDiffsGlobal: current.expandFileDiffsGlobal,
      itemOverrides: new Map(),
      fileDiffOverrides: new Map(),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      runningStatus: undefined,
    });
  }

  mergePersistSnapshot(
    items: ClassicTranscriptItem[],
  ): ClassicTranscriptItem[] {
    if (this.contentSource) return this.contentSource.mergePersistSnapshot(items);
    if (this.persistBase.length === 0 && this.persistHydratedIds.size === 0) {
      return items;
    }
    const fresh = items.filter((item) => !this.persistHydratedIds.has(item.id));
    if (this.persistBase.length === 0) {
      return fresh;
    }
    const updates = new Map(fresh.map((item) => [item.id, item]));
    const merged = this.persistBase.map((item) => {
      const update = updates.get(item.id);
      updates.delete(item.id);
      return update ?? item;
    });
    merged.push(...updates.values());
    this.persistBase = merged;
    return merged;
  }

  private setState(next: TranscriptState): void {
    if (this.applyState(next)) this.flushNotify();
  }

  private flushPendingEvents(): boolean {
    if (this.pendingEvents.length === 0) return false;
    const pending = this.pendingEvents;
    this.pendingEvents = [];
    const accepted: AnyAppEvent[] = [];
    let expected = this.state.lastSequence + 1;
    for (const event of pending) {
      if (event.sequence < expected) continue;
      if (event.sequence > expected) {
        throw new TranscriptSequenceError(expected, event.sequence);
      }
      accepted.push(event);
      expected += 1;
    }
    if (accepted.length === 0) return false;

    let next = this.state;
    for (let index = 0; index < accepted.length; index += 1) {
      const first = accepted[index]!;
      let lastIndex = index;
      let merged: AnyAppEvent = first;

      if (first.type === "assistant-delta") {
        const text = [first.payload.text];
        const firstIsVisible = first.payload.text.trim().length > 0;
        while (lastIndex + 1 < accepted.length) {
          const candidate = accepted[lastIndex + 1]!;
          if (
            candidate.type !== "assistant-delta" ||
            candidate.turnId !== first.turnId ||
            (!firstIsVisible && candidate.payload.text.trim().length > 0)
          ) {
            break;
          }
          lastIndex += 1;
          text.push(candidate.payload.text);
        }
        merged = {
          ...first,
          payload: { text: text.join("") },
        } as AnyAppEvent;
      } else if (first.type === "thinking-delta") {
        const text = [first.payload.text];
        while (lastIndex + 1 < accepted.length) {
          const candidate = accepted[lastIndex + 1]!;
          if (
            candidate.type !== "thinking-delta" ||
            candidate.turnId !== first.turnId ||
            candidate.payload.reasoningId !== first.payload.reasoningId
          ) {
            break;
          }
          lastIndex += 1;
          text.push(candidate.payload.text);
        }
        merged = {
          ...first,
          payload: { ...first.payload, text: text.join("") },
        } as AnyAppEvent;
      } else if (first.type === "tool-output") {
        while (lastIndex + 1 < accepted.length) {
          const candidate = accepted[lastIndex + 1]!;
          if (
            candidate.type !== "tool-output" ||
            candidate.payload.ref.toolCallId !==
              first.payload.ref.toolCallId
          ) {
            break;
          }
          lastIndex += 1;
        }
        const last = accepted[lastIndex] as Extract<
          AnyAppEvent,
          { type: "tool-output" }
        >;
        merged = { ...first, payload: last.payload } as AnyAppEvent;
      } else if (first.type === "compaction-delta") {
        let text = first.payload.text;
        let replace = first.payload.replace === true;
        while (lastIndex + 1 < accepted.length) {
          const candidate = accepted[lastIndex + 1]!;
          if (
            candidate.type !== "compaction-delta" ||
            candidate.payload.compactionId !==
              first.payload.compactionId
          ) {
            break;
          }
          lastIndex += 1;
          if (candidate.payload.replace) {
            text = candidate.payload.text;
            replace = true;
          } else {
            text += candidate.payload.text;
          }
        }
        merged = {
          ...first,
          payload: {
            ...first.payload,
            text,
            ...(replace ? { replace: true } : {}),
          },
        } as AnyAppEvent;
      }

      next = applyAppEvent(next, merged);
      const lastSequence = accepted[lastIndex]!.sequence;
      if (lastSequence !== merged.sequence) {
        next = { ...next, lastSequence };
      }
      index = lastIndex;
    }
    return this.applyState(next);
  }

  private applyState(next: TranscriptState): boolean {
    if (next === this.state) return false;
    if (next.expandFileDiffsGlobal === undefined) {
      next = { ...next, expandFileDiffsGlobal: true };
    }
    if (!next.fileDiffOverrides) {
      next = { ...next, fileDiffOverrides: new Map() };
    }
    if (!next.assistantStripStreams) {
      next = { ...next, assistantStripStreams: new Map() };
    }
    if (next.order.length > this.maxItems) {
      const evictionSlack = Math.min(
        128,
        Math.max(8, Math.floor(this.maxItems * 0.1)),
      );
      const targetSize = Math.max(1, this.maxItems - evictionSlack);
      const keep = new Set<string>();
      if (next.pendingAssistantId) keep.add(next.pendingAssistantId);
      if (next.pendingThinkingId) keep.add(next.pendingThinkingId);
      for (
        let index = next.order.length - 1;
        index >= 0 && keep.size < targetSize;
        index -= 1
      ) {
        keep.add(next.order[index]!);
      }
      const order = next.order.filter((id) => keep.has(id));
      const byId = new Map([...next.byId].filter(([id]) => keep.has(id)));
      const itemOverrides = new Map(
        [...next.itemOverrides].filter(([id]) => keep.has(id)),
      );
      const fileDiffOverrides = new Map(
        [...next.fileDiffOverrides].filter(([id]) => keep.has(id)),
      );
      const assistantStripStreams = new Map(
        [...next.assistantStripStreams].filter(([id]) => keep.has(id)),
      );
      next = {
        ...next,
        order,
        byId,
        itemOverrides,
        fileDiffOverrides,
        assistantStripStreams,
      };
    }
    this.state = next;
    return true;
  }

  private scheduleNotify(): void {
    this.notifyPending = true;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (!this.notifyPending) return;
      this.flushPendingEvents();
      this.flushNotify();
    }, this.coalesceMs);
  }

  private flushNotify(): void {
    this.flushPendingEvents();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.notifyPending = false;
    for (const listener of this.listeners) listener();
  }

  private clearPendingEvents(): void {
    this.pendingEvents = [];
    this.notifyPending = false;
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
  }
}
