/**
 * Single owner of the one blocking overlay (V2-071..076, PICK-002).
 *
 * Holds the overlay's data (picker options, confirm prompt, pager body) and
 * coordinates with `FocusController`'s context stack so opening while one is
 * already active is rejected (nested-action prevention) and closing restores
 * whichever base region had focus (focus restoration) — both for free from
 * `FocusController`'s existing single-slot design, not reimplemented here.
 */

import type { FocusController, OverlayContext } from "./focus-controller.js";
import type { PickerOption } from "../rendering/picker-filter.js";

export type ConfirmKind = "tool" | "pentest" | "reset" | "continue" | "plan" | "switch";

export interface ConfirmRequest {
  readonly kind: ConfirmKind;
  readonly prompt: string;
}

export interface PickerRequest {
  readonly title: string;
  readonly options: readonly PickerOption[];
  readonly searchDescription?: boolean | undefined;
  readonly twoLine?: boolean | undefined;
  /**
   * History-oriented chrome: larger panel, session badges, clearer filter
   * line, and description-aware search.
   */
  readonly historyStyle?: boolean | undefined;
}

export interface SecretRequestView {
  readonly title: string;
  readonly prompt: string;
}

export interface PromptActionsRequest {
  readonly prompt: string;
  readonly onResend: () => void;
}

export type OverlayState =
  | { readonly kind: "none" }
  | { readonly kind: "picker"; readonly request: PickerRequest; readonly onSelect: (value: string) => void }
  | {
      readonly kind: "confirm";
      readonly request: ConfirmRequest;
      readonly resolve: (ok: boolean) => void;
      readonly onViewPlan?: (() => void) | undefined;
    }
  | { readonly kind: "secret"; readonly request: SecretRequestView; readonly resolve: (value: string | undefined) => void }
  | { readonly kind: "prompt-actions"; readonly request: PromptActionsRequest }
  | { readonly kind: "pager"; readonly title: string; readonly body: string }
  | { readonly kind: "jobs" };

export type OverlayListener = () => void;

const NONE: OverlayState = { kind: "none" };

export class OverlayController {
  private state: OverlayState = NONE;
  /** Confirm suspended under a plan-detail pager (classic TUI: confirm chrome + pager overlay). */
  private suspended: OverlayState | undefined;
  private readonly listeners = new Set<OverlayListener>();
  private closeFocus: (() => void) | undefined;

  constructor(private readonly focus: FocusController) {}

  getState(): OverlayState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state.kind !== "none";
  }

  subscribe(listener: OverlayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  openPicker(request: PickerRequest, onSelect: (value: string) => void): boolean {
    return this.open({ kind: "picker", request, onSelect }, "picker");
  }

  /**
   * Opens a pager. Allowed over an open plan confirm so "P" can show full
   * plan detail without resolving the confirm (F-021); closing the pager
   * restores the suspended confirm. Any other open overlay is still rejected.
   */
  openPager(title: string, body: string): boolean {
    if (this.state.kind === "confirm" && this.state.request.kind === "plan" && !this.suspended) {
      return this.suspendUnder({ kind: "pager", title, body }, "pager");
    }
    return this.open({ kind: "pager", title, body }, "pager");
  }

  openJobs(): boolean {
    return this.open({ kind: "jobs" }, "jobs");
  }

  openPromptActions(request: PromptActionsRequest): boolean {
    return this.open({ kind: "prompt-actions", request }, "modal");
  }

  /** Resolves `false` if a blocking overlay was already open rather than hanging. */
  openConfirm(request: ConfirmRequest, onViewPlan?: () => void): Promise<boolean> {
    return new Promise((resolve) => {
      const opened = this.open({ kind: "confirm", request, resolve, onViewPlan }, "modal");
      if (!opened) resolve(false);
    });
  }

  /** Resolves `undefined` if a blocking overlay was already open rather than hanging. */
  openSecret(request: SecretRequestView): Promise<string | undefined> {
    return new Promise((resolve) => {
      const opened = this.open({ kind: "secret", request, resolve }, "secret");
      if (!opened) resolve(undefined);
    });
  }

  answerConfirm(ok: boolean): void {
    const confirm = this.activeConfirm();
    if (!confirm) return;
    const { resolve } = confirm;
    this.suspended = undefined;
    this.forceClose();
    resolve(ok);
  }

  answerSecret(value: string | undefined): void {
    if (this.state.kind !== "secret") return;
    const { resolve } = this.state;
    this.forceClose();
    resolve(value);
  }

  /** The picker's own `onSelect` decides whether/when to close (e.g. a
   * provider pick may chain into a secret prompt instead of closing). */
  selectPicker(value: string): void {
    if (this.state.kind !== "picker") return;
    this.state.onSelect(value);
  }

  close(): void {
    if (this.state.kind === "none") return;
    if (this.suspended) {
      this.restoreSuspended();
      return;
    }
    this.forceClose();
  }

  dispose(): void {
    if (this.suspended?.kind === "confirm") this.suspended.resolve(false);
    else if (this.state.kind === "confirm") this.state.resolve(false);
    else if (this.state.kind === "secret") this.state.resolve(undefined);
    this.suspended = undefined;
    this.forceClose();
    this.listeners.clear();
  }

  private activeConfirm(): Extract<OverlayState, { kind: "confirm" }> | undefined {
    if (this.state.kind === "confirm") return this.state;
    if (this.suspended?.kind === "confirm") return this.suspended;
    return undefined;
  }

  private open(next: OverlayState, context: OverlayContext): boolean {
    if (this.state.kind !== "none" || this.suspended) return false;
    try {
      this.closeFocus = this.focus.pushOverlay(context);
    } catch {
      return false;
    }
    this.state = next;
    this.notify();
    return true;
  }

  private suspendUnder(next: OverlayState, context: OverlayContext): boolean {
    this.suspended = this.state;
    this.closeFocus?.();
    try {
      this.closeFocus = this.focus.pushOverlay(context);
    } catch {
      this.suspended = undefined;
      try {
        this.closeFocus = this.focus.pushOverlay("modal");
      } catch {
        this.closeFocus = undefined;
      }
      return false;
    }
    this.state = next;
    this.notify();
    return true;
  }

  private restoreSuspended(): void {
    const previous = this.suspended;
    this.suspended = undefined;
    this.closeFocus?.();
    this.closeFocus = undefined;
    if (!previous || previous.kind === "none") {
      this.state = NONE;
      this.notify();
      return;
    }
    const context: OverlayContext =
      previous.kind === "confirm"
        ? "modal"
        : previous.kind === "secret"
          ? "secret"
          : previous.kind === "picker"
            ? "picker"
            : previous.kind === "jobs"
              ? "jobs"
              : previous.kind === "prompt-actions"
                ? "modal"
              : "pager";
    try {
      this.closeFocus = this.focus.pushOverlay(context);
      this.state = previous;
    } catch {
      this.state = NONE;
      if (previous.kind === "confirm") previous.resolve(false);
      else if (previous.kind === "secret") previous.resolve(undefined);
    }
    this.notify();
  }

  private forceClose(): void {
    this.state = NONE;
    this.closeFocus?.();
    this.closeFocus = undefined;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
