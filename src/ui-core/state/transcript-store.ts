/**
 * Observable wrapper around the pure transcript reducer (V2-050).
 *
 * The only side effect this store performs is notifying subscribers; state
 * transitions themselves stay in `applyAppEvent` so they remain replayable
 * and unit-testable without a subscriber. Components read state through
 * `getState`/`subscribe` (a `useSyncExternalStore` source), never by reaching
 * into reducer internals.
 */

import type { AnyAppEvent } from "../../app/events/app-event.js";
import { applyAppEvent } from "./transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE, type TranscriptState } from "./transcript-types.js";

export type TranscriptListener = () => void;

export class TranscriptStore {
  private state: TranscriptState = EMPTY_TRANSCRIPT_STATE;
  private readonly listeners = new Set<TranscriptListener>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyPending = false;

  // Token-rate events fire dozens of times per second; notifying React on each
  // one re-reconciles the whole transcript and starves composer input. Batch
  // these to one paint frame while structural events still flush immediately.
  private static readonly COALESCED_EVENT_TYPES = new Set<string>([
    "assistant-delta",
    "thinking-delta",
    "tool-output",
  ]);

  constructor(
    private readonly maxItems = 2_000,
    private readonly coalesceMs = 16,
  ) {
    if (!Number.isInteger(maxItems) || maxItems <= 0) throw new RangeError("maxItems must be positive");
  }

  getState(): TranscriptState {
    return this.state;
  }

  dispatch(event: AnyAppEvent): void {
    if (!this.applyState(applyAppEvent(this.state, event))) return;
    if (TranscriptStore.COALESCED_EVENT_TYPES.has(event.type)) {
      this.scheduleNotify();
    } else {
      this.flushNotify();
    }
  }

  /** CHAT-006: Ctrl+T toggles every thinking block's default visibility. */
  toggleThinkingGlobal(): void {
    this.setState({ ...this.state, expandThinkingGlobal: !this.state.expandThinkingGlobal });
  }

  /** CHAT-005/007: Ctrl+O toggles tool OUTPUT + compacted memory cards. */
  toggleOutputGlobal(): void {
    this.setState({ ...this.state, expandOutputGlobal: !this.state.expandOutputGlobal });
  }

  /** Expand/collapse every tool OUTPUT card at once (collapse all / expand
   *  all chips). Clears only tool/compacted per-item overrides so thinking
   *  overrides survive. */
  setOutputGlobal(expanded: boolean): void {
    const overrides = new Map(this.state.itemOverrides);
    for (const id of [...overrides.keys()]) {
      const item = this.state.byId.get(id);
      if (item && (item.kind === "tool" || item.kind === "compacted")) {
        overrides.delete(id);
      }
    }
    this.setState({ ...this.state, expandOutputGlobal: expanded, itemOverrides: overrides });
  }

  /** Expand/collapse every file-diff card in chat (hunks vs title-only). */
  setFileDiffsGlobal(expanded: boolean): void {
    this.setState({
      ...this.state,
      expandFileDiffsGlobal: expanded,
      // Clear per-card overrides so global applies cleanly.
      fileDiffOverrides: new Map(),
    });
  }

  toggleFileDiffsGlobal(): void {
    this.setFileDiffsGlobal(!this.state.expandFileDiffsGlobal);
  }

  /** Expand/collapse one tool's file-diff body. */
  toggleFileDiffOverride(toolItemId: string, fallback: boolean): void {
    const overrides = new Map(this.state.fileDiffOverrides);
    const current = overrides.get(toolItemId) ?? fallback;
    overrides.set(toolItemId, !current);
    this.setState({ ...this.state, fileDiffOverrides: overrides });
  }

  /** Expand/collapse one item, overriding whichever global toggle applies. */
  toggleItemOverride(id: string, fallback: boolean): void {
    const overrides = new Map(this.state.itemOverrides);
    const current = overrides.get(id) ?? fallback;
    overrides.set(id, !current);
    this.setState({ ...this.state, itemOverrides: overrides });
  }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.setState(EMPTY_TRANSCRIPT_STATE);
  }

  /**
   * Replace the entire visual transcript (used by /history resume).
   * Preserves global expand toggles so user prefs survive a session switch.
   */
  hydrate(next: TranscriptState): void {
    this.setState({
      ...next,
      expandThinkingGlobal: this.state.expandThinkingGlobal,
      expandOutputGlobal: this.state.expandOutputGlobal,
      expandFileDiffsGlobal: this.state.expandFileDiffsGlobal,
      itemOverrides: new Map(),
      fileDiffOverrides: new Map(),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      runningStatus: undefined,
    });
  }

  private setState(next: TranscriptState): void {
    if (this.applyState(next)) this.flushNotify();
  }

  private applyState(next: TranscriptState): boolean {
    if (next === this.state) return false;
    // Backfill fields for older hydrated states.
    if (next.expandFileDiffsGlobal === undefined) {
      next = { ...next, expandFileDiffsGlobal: true };
    }
    if (!next.fileDiffOverrides) {
      next = { ...next, fileDiffOverrides: new Map() };
    }
    if (next.order.length > this.maxItems) {
      const keep = new Set(next.order.slice(-this.maxItems));
      if (next.pendingAssistantId) keep.add(next.pendingAssistantId);
      if (next.pendingThinkingId) keep.add(next.pendingThinkingId);
      const order = next.order.filter((id) => keep.has(id));
      const byId = new Map([...next.byId].filter(([id]) => keep.has(id)));
      const itemOverrides = new Map([...next.itemOverrides].filter(([id]) => keep.has(id)));
      const fileDiffOverrides = new Map(
        [...next.fileDiffOverrides].filter(([id]) => keep.has(id)),
      );
      next = { ...next, order, byId, itemOverrides, fileDiffOverrides };
    }
    this.state = next;
    return true;
  }

  private scheduleNotify(): void {
    this.notifyPending = true;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (this.notifyPending) this.flushNotify();
    }, this.coalesceMs);
  }

  private flushNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    this.notifyPending = false;
    for (const listener of this.listeners) listener();
  }
}
