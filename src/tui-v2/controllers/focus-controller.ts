/**
 * Focus + overlay ownership (V2-033, groundwork for V2-076).
 *
 * Single owner for where keyboard input is routed. The base focus is one of
 * the visible regions; a blocking overlay (picker/modal/secret/search) takes
 * precedence while open. Only one blocking overlay may be active at a time so
 * nested actions cannot stack; opening a second is rejected rather than
 * silently shadowing the first.
 */

import type { ActionContext } from "../actions/action-id.js";

export type FocusRegion = "composer" | "transcript" | "plan";
export type OverlayContext = "picker" | "modal" | "secret" | "transcript-search" | "pager" | "jobs";

const DEFAULT_REGION_ORDER: readonly FocusRegion[] = [
  "composer",
  "transcript",
  "plan",
];

export class FocusController {
  private currentRegion: FocusRegion;
  private overlay: OverlayContext | undefined;
  private readonly listeners = new Set<(context: ActionContext) => void>();

  constructor(
    initialRegion: FocusRegion = "composer",
    private readonly regionOrder: readonly FocusRegion[] = DEFAULT_REGION_ORDER,
  ) {
    this.currentRegion = initialRegion;
  }

  activeContext(): ActionContext {
    return this.overlay ?? this.currentRegion;
  }

  region(): FocusRegion {
    return this.currentRegion;
  }

  hasOverlay(): boolean {
    return this.overlay !== undefined;
  }

  focusRegion(region: FocusRegion): void {
    if (this.currentRegion === region) return;
    this.currentRegion = region;
    if (!this.overlay) this.notify();
  }

  /** Move focus to the next visible region, skipping overlays. */
  cycleRegion(visible: readonly FocusRegion[] = this.regionOrder): FocusRegion {
    const order = visible.length > 0 ? visible : this.regionOrder;
    const idx = order.indexOf(this.currentRegion);
    const next = order[(idx + 1) % order.length] ?? this.currentRegion;
    this.focusRegion(next);
    return next;
  }

  /** Open a blocking overlay; returns a disposer that closes it. */
  pushOverlay(context: OverlayContext): () => void {
    if (this.overlay) {
      throw new Error(
        `a blocking overlay (${this.overlay}) is already open; close it before opening ${context}`,
      );
    }
    this.overlay = context;
    this.notify();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (this.overlay === context) this.popOverlay();
    };
  }

  popOverlay(): void {
    if (!this.overlay) return;
    this.overlay = undefined;
    this.notify();
  }

  onChange(listener: (context: ActionContext) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const context = this.activeContext();
    for (const listener of this.listeners) listener(context);
  }
}
