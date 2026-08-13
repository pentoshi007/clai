import type { ActionContext, ActionId } from "../../ui-core/actions/action-id.js";
import type { ActionRouter } from "../../ui-core/actions/action-router.js";
import type { FocusController } from "../../ui-core/controllers/focus-controller.js";
import type { CancelLadder } from "./cancel-ladder.js";
import { chordFromKey } from "./chord-from-key.js";
import type { DecodedEvent, KeyEvent, MouseEvent } from "./key-event.js";

const BLOCKING_CONTEXTS: ReadonlySet<ActionContext> = new Set(["secret", "modal"]);

const OVERLAY_CONTEXTS: ReadonlySet<ActionContext> = new Set([
  "secret",
  "modal",
  "picker",
  "pager",
  "jobs",
  "transcript-search",
]);

export interface InputRouterDeps {
  readonly focus: FocusController;
  readonly router: ActionRouter;
  readonly ladder: CancelLadder;
  readonly onAction: (action: ActionId, chord: string, key: KeyEvent) => void;
  readonly onPanelKey: (key: KeyEvent, chord: string, context: ActionContext) => void;
  readonly onText: (text: string) => void;
  readonly onPaste: (text: string) => void;
  readonly onMouse: (event: MouseEvent) => void;
  readonly onToast: (text: string) => void;
  readonly closeOverlay: () => void;
  readonly dismissBlockingPrompt: () => boolean;
  readonly acceptsPaste: () => boolean;
  readonly acceptsText: () => boolean;
  readonly hasSelection: () => boolean;
  readonly contextLimitEditing?: (() => boolean) | undefined;
  readonly onContextLimitStart?: (() => void) | undefined;
  readonly onContextLimitKey?: ((key: KeyEvent, chord: string) => void) | undefined;
  readonly onContextLimitPaste?: ((text: string) => void) | undefined;
}

export class InputRouter {
  constructor(private readonly deps: InputRouterDeps) {}

  handle(event: DecodedEvent): void {
    if (event.type === "paste") {
      if (this.deps.contextLimitEditing?.() === true) {
        this.deps.onContextLimitPaste?.(event.text);
      } else if (this.deps.acceptsPaste()) this.deps.onPaste(event.text);
      else this.deps.onToast("paste ignored · focus the input first");
      return;
    }
    if (event.type === "mouse") {
      this.deps.onMouse(event.event);
      return;
    }
    this.routeKey(event.key);
  }

  handleAll(events: readonly DecodedEvent[]): void {
    for (const event of events) this.handle(event);
  }

  private routeKey(key: KeyEvent): void {
    const chord = chordFromKey(key);
    const context = this.deps.focus.activeContext();

    if (BLOCKING_CONTEXTS.has(context)) {
      if (chord === "ctrl+c") {
        this.deps.ladder.interrupt();
        return;
      }
      if (chord === "escape") {
        this.deps.ladder.escape(this.deps.dismissBlockingPrompt());
        return;
      }
      this.deps.onPanelKey(key, chord, context);
      return;
    }

    if (OVERLAY_CONTEXTS.has(context)) {
      // An overlay (pager, picker, jobs, search…) owns the screen region;
      // ctrl+c there means "get me out", never "abort the turn".
      if (chord === "ctrl+c") {
        this.deps.closeOverlay();
        this.deps.ladder.escape(true);
        return;
      }
      if (chord === "escape") {
        this.deps.closeOverlay();
        this.deps.ladder.escape(true);
        return;
      }
      this.dispatchOrPanel(key, chord, context);
      return;
    }

    const contextEditing = this.deps.contextLimitEditing?.() === true;
    if (contextEditing) {
      if (chord === "ctrl+c") {
        this.deps.ladder.interrupt();
        return;
      }
      this.deps.onContextLimitKey?.(key, chord);
      return;
    }

    if (context === "composer" && chord === "ctrl+l") {
      this.deps.onContextLimitStart?.();
      return;
    }

    if (chord === "escape" && context === "transcript" && !this.deps.hasSelection()) {
      this.deps.ladder.escape(false);
      return;
    }

    if (context === "composer" && chord === "tab") {
      this.deps.onPanelKey(key, chord, context);
      return;
    }
    if (context === "composer") {
      const composerChords = new Set([
        "alt+backspace",
        "meta+backspace",
        "ctrl+backspace",
        "super+backspace",
        "alt+delete",
        "meta+delete",
        "ctrl+delete",
        "super+delete",
        "ctrl+u",
        "meta+u",
        "ctrl+k",
        "alt+enter",
        "ctrl+enter",
        "meta+enter",
        "super+enter",
        "ctrl+n",
      ]);
      if (composerChords.has(chord) || chord.endsWith("+backspace") || chord.endsWith("+delete")) {
        this.deps.onPanelKey(key, chord, context);
        return;
      }
    }
    if (
      context === "composer" &&
      (chord === "pageup" || chord === "pagedown" || chord === "ctrl+u" || chord === "ctrl+d")
    ) {
      const action = this.deps.router.resolve(chord, "transcript");
      if (action) {
        this.deps.onAction(action, chord, key);
        return;
      }
    }

    this.dispatchOrPanel(key, chord, context);
  }

  private dispatchOrPanel(key: KeyEvent, chord: string, context: ActionContext): void {
    const action = this.deps.router.resolve(chord, context);
    if (action === "app.interrupt") {
      this.deps.ladder.interrupt();
      return;
    }
    if (action === "app.cancel") {
      this.deps.ladder.escape(this.deps.dismissBlockingPrompt());
      return;
    }
    if (action) {
      this.deps.onAction(action, chord, key);
      return;
    }
    if (
      key.text.length > 0 &&
      !OVERLAY_CONTEXTS.has(context) &&
      this.deps.acceptsText()
    ) {
      this.deps.onText(key.text);
      return;
    }
    this.deps.onPanelKey(key, chord, context);
  }
}
