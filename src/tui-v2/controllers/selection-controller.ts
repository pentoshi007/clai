/**
 * Pane-scoped selection owner (V2-060..064).
 *
 * Owns semantic anchors, drag state, keyboard extension, and explicit copy
 * (Ctrl+Shift+C). Auto-copy-on-release is off by default — OpenTUI native
 * selection must not be fought by delayed clipboard side-effects.
 */

import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import { sanitizeDisplayText } from "../rendering/sanitize-display.js";
import type { ActionId } from "../actions/action-id.js";
import {
  clampSemanticAnchor,
  compareSemanticAnchors,
  documentEnd,
  documentStart,
  moveSemanticAnchor,
  normalizeSemanticDocument,
  semanticLineRange,
  semanticRangeText,
  semanticWordRange,
  type SemanticAnchor,
  type SemanticDocument,
  type SemanticMovement,
  type SemanticRange,
} from "../state/semantic-document.js";

export type SelectionPane = "transcript" | "plan";
export type SelectionGranularity = "character" | "word" | "line";

export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/** Native scroll primitives are injected to keep this controller renderer-independent. */
export interface DragEdgeScrollPort {
  startAutoScroll(x: number, y: number): void;
  updateAutoScroll(x: number, y: number): void;
  stopAutoScroll(): void;
}

export interface PaneSelectionRange extends SemanticRange {
  readonly pane: SelectionPane;
}

export interface SelectionState {
  readonly activePane: SelectionPane | undefined;
  readonly range: PaneSelectionRange | undefined;
  readonly dragging: boolean;
  readonly autoscrollPane: SelectionPane | undefined;
}

export type SelectionCopyResult =
  | { readonly status: "copied"; readonly text: string }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly error: unknown };

export type SelectionListener = () => void;

export interface SelectionControllerOptions {
  /** Auto-copy on mouse release. Default false (disabled — was breaking touch/TUI). */
  readonly copyOnRelease?: boolean | undefined;
}

const EMPTY_SELECTION_STATE: SelectionState = {
  activePane: undefined,
  range: undefined,
  dragging: false,
  autoscrollPane: undefined,
};

export class SelectionController {
  private readonly documents = new Map<SelectionPane, SemanticDocument>();
  private readonly scrollPorts = new Map<SelectionPane, DragEdgeScrollPort>();
  private readonly listeners = new Set<SelectionListener>();
  private readonly copyOnRelease: boolean;
  private state: SelectionState = EMPTY_SELECTION_STATE;

  constructor(
    private readonly clipboard: ClipboardPort,
    options: SelectionControllerOptions = {},
  ) {
    this.copyOnRelease = options.copyOnRelease ?? false;
  }

  getState(): SelectionState {
    return this.state;
  }

  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setDocument(pane: SelectionPane, document: SemanticDocument): void {
    const normalized = normalizeSemanticDocument(document);
    this.documents.set(pane, normalized);
    const range = this.state.range;
    if (!range || range.pane !== pane) return;

    const anchor = clampSemanticAnchor(normalized, range.anchor, "start");
    const focus = clampSemanticAnchor(normalized, range.focus, "end");
    if (!anchor || !focus) {
      this.clear();
      return;
    }
    this.setState({ ...this.state, range: { pane, anchor, focus } });
  }

  registerScrollPort(pane: SelectionPane, port: DragEdgeScrollPort): () => void {
    this.scrollPorts.set(pane, port);
    return () => {
      if (this.scrollPorts.get(pane) !== port) return;
      if (this.state.autoscrollPane === pane) port.stopAutoScroll();
      this.scrollPorts.delete(pane);
    };
  }

  beginDrag(pane: SelectionPane, requested: SemanticAnchor, pointer?: PointerPosition): boolean {
    const anchor = this.clamp(pane, requested);
    if (!anchor) return false;
    this.stopAutoscroll();
    this.setState({
      activePane: pane,
      range: { pane, anchor, focus: anchor },
      dragging: true,
      autoscrollPane: undefined,
    });
    if (pointer) this.startAutoscroll(pane, pointer);
    return true;
  }

  dragTo(pane: SelectionPane, requested: SemanticAnchor, pointer?: PointerPosition): boolean {
    const range = this.state.range;
    const activePane = this.state.activePane;
    if (!range || !this.state.dragging || !activePane) return false;
    if (pointer) this.updateAutoscroll(activePane, pointer);
    if (pane !== activePane) return false;

    const focus = this.clamp(pane, requested);
    if (!focus) return false;
    this.setState({ ...this.state, range: { ...range, focus } });
    return true;
  }

  finishDrag(): void {
    if (!this.state.dragging && !this.state.autoscrollPane) return;
    this.stopAutoscroll();
    this.setState({ ...this.state, dragging: false, autoscrollPane: undefined });
    this.maybeAutoCopy();
  }

  click(
    pane: SelectionPane,
    requested: SemanticAnchor,
    granularity: SelectionGranularity = "character",
  ): boolean {
    this.finishDrag();
    const anchor = this.clamp(pane, requested);
    if (!anchor) return false;
    const document = this.documents.get(pane)!;
    const range =
      granularity === "word"
        ? semanticWordRange(document, anchor)
        : granularity === "line"
          ? semanticLineRange(document, anchor)
          : { anchor, focus: anchor };
    if (!range) return false;
    this.setState({ activePane: pane, range: { pane, ...range }, dragging: false, autoscrollPane: undefined });
    this.maybeAutoCopy();
    return true;
  }

  extend(pane: SelectionPane, movement: SemanticMovement): boolean {
    const document = this.documents.get(pane);
    if (!document) return false;
    const existing = this.state.range?.pane === pane ? this.state.range : undefined;
    const anchor = existing?.anchor ?? documentStart(document);
    const focus = existing?.focus ?? anchor;
    if (!anchor || !focus) return false;
    const nextFocus = moveSemanticAnchor(document, focus, movement);
    if (!nextFocus) return false;
    this.finishDrag();
    this.setState({
      activePane: pane,
      range: { pane, anchor, focus: nextFocus },
      dragging: false,
      autoscrollPane: undefined,
    });
    return true;
  }

  selectAll(pane: SelectionPane): boolean {
    const document = this.documents.get(pane);
    if (!document) return false;
    const anchor = documentStart(document);
    const focus = documentEnd(document);
    if (!anchor || !focus) return false;
    this.finishDrag();
    this.setState({ activePane: pane, range: { pane, anchor, focus }, dragging: false, autoscrollPane: undefined });
    return true;
  }

  clear(): void {
    this.stopAutoscroll();
    this.setState(EMPTY_SELECTION_STATE);
  }

  selectedText(): string {
    const range = this.state.range;
    if (!range) return "";
    const document = this.documents.get(range.pane);
    if (!document || compareSemanticAnchors(document, range.anchor, range.focus) === 0) return "";
    return sanitizeDisplayText(semanticRangeText(document, range));
  }

  hasSelection(): boolean {
    return this.selectedText().length > 0;
  }

  async copy(): Promise<SelectionCopyResult> {
    const text = this.selectedText();
    if (!text) return { status: "empty" };
    try {
      await this.clipboard.writeText(text);
      return { status: "copied", text };
    } catch (error) {
      return { status: "failed", error };
    }
  }

  handleAction(action: ActionId, pane: SelectionPane): boolean {
    switch (action) {
      case "selection.copy":
        void this.copy();
        return true;
      case "selection.clear":
        this.clear();
        return true;
      case "selection.select-all":
        return this.selectAll(pane);
      case "selection.extend-left":
        return this.extend(pane, "left");
      case "selection.extend-right":
        return this.extend(pane, "right");
      case "selection.extend-up":
        return this.extend(pane, "up");
      case "selection.extend-down":
        return this.extend(pane, "down");
      case "selection.extend-word-left":
        return this.extend(pane, "word-left");
      case "selection.extend-word-right":
        return this.extend(pane, "word-right");
      case "selection.extend-line-start":
        return this.extend(pane, "line-start");
      case "selection.extend-line-end":
        return this.extend(pane, "line-end");
      default:
        return false;
    }
  }

  dispose(): void {
    this.stopAutoscroll();
    this.listeners.clear();
    this.scrollPorts.clear();
    this.documents.clear();
  }

  private maybeAutoCopy(): void {
    if (this.copyOnRelease && this.selectedText()) void this.copy();
  }

  private clamp(pane: SelectionPane, anchor: SemanticAnchor): SemanticAnchor | undefined {
    const document = this.documents.get(pane);
    return document ? clampSemanticAnchor(document, anchor) : undefined;
  }

  private startAutoscroll(pane: SelectionPane, pointer: PointerPosition): void {
    this.scrollPorts.get(pane)?.startAutoScroll(pointer.x, pointer.y);
    this.setState({ ...this.state, autoscrollPane: pane });
  }

  private updateAutoscroll(pane: SelectionPane, pointer: PointerPosition): void {
    if (this.state.autoscrollPane !== pane) this.startAutoscroll(pane, pointer);
    else this.scrollPorts.get(pane)?.updateAutoScroll(pointer.x, pointer.y);
  }

  private stopAutoscroll(): void {
    const pane = this.state.autoscrollPane;
    if (pane) this.scrollPorts.get(pane)?.stopAutoScroll();
  }

  private setState(next: SelectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
