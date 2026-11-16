import type { FocusController } from "../../ui-core/controllers/focus-controller.js";
import { hasSearchQuery, stepMatchIndex } from "../../ui-core/state/text-search.js";
import type { FeedBlock } from "./feed-blocks.js";
import {
  feedMatchIndex,
  findFeedMatches,
  nearestFeedMatch,
  type FeedMatch,
  type FeedMatchIdentity,
  type FeedMatchPosition,
} from "./feed-search.js";
import { isPrintable } from "../panels/picker-panel.js";

export interface TranscriptFindSnapshot {
  readonly open: boolean;
  readonly editing: boolean;
  readonly query: string;
  readonly active: FeedMatchIdentity | undefined;
}

export interface TranscriptFindPort {
  readonly focus: FocusController;
  blocks(): readonly FeedBlock[];
  anchor(): FeedMatchPosition | undefined;
  reveal(match: FeedMatch): void;
  notify(text: string, level?: "info" | "warn"): void;
}

const CLOSED: TranscriptFindSnapshot = { open: false, editing: false, query: "", active: undefined };

function deleteWordBackward(query: string): string {
  return query.replace(/\s*\S+\s*$/u, "");
}

export class TranscriptFind {
  private snapshot: TranscriptFindSnapshot = CLOSED;
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | undefined;
  private origin: FeedMatchPosition | undefined;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly port: TranscriptFindPort) {
    this.unsubscribeFocus = port.focus.onChange((context) => {
      if (!this.release || context === "transcript-search") return;
      this.release = undefined;
      if (this.snapshot.editing) this.publish({ ...this.snapshot, editing: false });
    });
  }

  getSnapshot = (): TranscriptFindSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispose(): void {
    this.unsubscribeFocus();
    this.releaseFocus();
    this.listeners.clear();
  }

  capturesInput(): boolean {
    return this.snapshot.editing && this.port.focus.activeContext() === "transcript-search";
  }

  matches(blocks: readonly FeedBlock[] = this.port.blocks()): readonly FeedMatch[] {
    return findFeedMatches(blocks, this.snapshot.query);
  }

  activeIndex(matches: readonly FeedMatch[] = this.matches()): number {
    return feedMatchIndex(matches, this.snapshot.active);
  }

  open(): void {
    if (this.capturesInput()) {
      this.step(-1);
      return;
    }
    if (this.port.focus.hasOverlay()) return;
    try {
      this.release = this.port.focus.pushOverlay("transcript-search");
    } catch {
      return;
    }
    const matches = this.matches();
    this.origin = matches[this.activeIndex(matches)] ?? this.port.anchor();
    this.publish({ ...this.snapshot, open: true, editing: true });
  }

  close(): boolean {
    if (!this.snapshot.open) return false;
    this.releaseFocus();
    this.origin = undefined;
    this.publish(CLOSED);
    return true;
  }

  handleKey(chord: string, text?: string): boolean {
    if (this.capturesInput()) return this.handleEditingKey(chord, text);
    if (!this.snapshot.open || this.port.focus.activeContext() !== "transcript") return false;
    if (chord === "escape") return this.close();
    if (!hasSearchQuery(this.snapshot.query)) return false;
    if (chord === "n") this.step(1);
    else if (chord === "shift+n") this.step(-1);
    else return false;
    return true;
  }

  paste(text: string): boolean {
    if (!this.capturesInput()) return false;
    this.setQuery(`${this.snapshot.query}${text.replace(/\s+/gu, " ")}`);
    return true;
  }

  step(delta: 1 | -1): void {
    const matches = this.matches();
    if (matches.length === 0) {
      if (hasSearchQuery(this.snapshot.query)) this.port.notify("No matches", "warn");
      return;
    }
    const current = this.activeIndex(matches);
    const index = current < 0
      ? nearestFeedMatch(matches, this.reference(matches))
      : stepMatchIndex(matches.length, current, delta);
    if (current >= 0 && matches.length > 1 && (delta > 0 ? index < current : index > current)) {
      this.port.notify(delta > 0 ? "Search wrapped to the first match" : "Search wrapped to the last match");
    }
    this.select(matches[index]!);
  }

  private handleEditingKey(chord: string, text: string | undefined): boolean {
    if (chord === "ctrl+c") return false;
    if (chord === "escape") return this.close();
    if (chord === "enter") return this.accept();
    if (chord === "up" || chord === "ctrl+r") this.step(-1);
    else if (chord === "down") this.step(1);
    else if (chord === "backspace") this.setQuery(this.snapshot.query.slice(0, -1));
    else if (chord === "ctrl+u") this.setQuery("");
    else if (chord === "ctrl+w" || chord === "alt+backspace" || chord === "ctrl+backspace") {
      this.setQuery(deleteWordBackward(this.snapshot.query));
    } else if (isPrintable(chord, text)) this.setQuery(`${this.snapshot.query}${text ?? ""}`);
    return true;
  }

  private accept(): boolean {
    if (!hasSearchQuery(this.snapshot.query)) return this.close();
    const matches = this.matches();
    if (matches.length === 0) {
      this.port.notify("No matches", "warn");
      return true;
    }
    if (this.activeIndex(matches) < 0) this.select(matches[nearestFeedMatch(matches, this.reference(matches))]!);
    this.releaseFocus();
    this.port.focus.focusRegion("transcript");
    this.publish({ ...this.snapshot, editing: false });
    return true;
  }

  private reference(matches: readonly FeedMatch[]): FeedMatchPosition {
    return matches[this.activeIndex(matches)]
      ?? this.origin
      ?? this.port.anchor()
      ?? { blockIndex: Number.MAX_SAFE_INTEGER, lineIndex: 0, start: 0 };
  }

  private setQuery(query: string): void {
    const previous = this.matches();
    const reference = this.reference(previous);
    this.publish({ ...this.snapshot, query });
    const matches = this.matches();
    const index = nearestFeedMatch(matches, reference);
    if (index < 0) {
      this.publish({ ...this.snapshot, active: undefined });
      return;
    }
    this.select(matches[index]!);
  }

  private select(match: FeedMatch): void {
    this.publish({ ...this.snapshot, active: { itemId: match.itemId, occurrence: match.occurrence } });
    this.port.reveal(match);
  }

  private releaseFocus(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  private publish(snapshot: TranscriptFindSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
