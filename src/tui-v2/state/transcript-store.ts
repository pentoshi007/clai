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

  getState(): TranscriptState {
    return this.state;
  }

  dispatch(event: AnyAppEvent): void {
    this.setState(applyAppEvent(this.state, event));
  }

  /** CHAT-006: Ctrl+T toggles every thinking block's default visibility. */
  toggleThinkingGlobal(): void {
    this.setState({ ...this.state, expandThinkingGlobal: !this.state.expandThinkingGlobal });
  }

  /** CHAT-005/007: Ctrl+O toggles tool OUTPUT + compacted memory cards. */
  toggleOutputGlobal(): void {
    this.setState({ ...this.state, expandOutputGlobal: !this.state.expandOutputGlobal });
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
      itemOverrides: new Map(),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      runningStatus: undefined,
    });
  }

  private setState(next: TranscriptState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
