/** @jsxImportSource @opentui/react */
/** Renderer adapter for the pure pane-scoped selection controller. */

import { useEffect, useRef, type RefObject } from "react";
import type { KeyEvent, MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import {
  documentEnd,
  documentStart,
  type SemanticAnchor,
  type SemanticDocument,
} from "../../../ui-core/state/semantic-document.js";
import { isItemExpanded, type TranscriptState } from "../../../ui-core/state/transcript-types.js";

import { extractTranscriptSemanticDocument } from "../../../ui-core/rendering/transcript-semantic.js";

interface TranscriptSelectionOptions {
  readonly services: AppServices;
  readonly state: TranscriptState;
  readonly spool: OutputSpool;
  readonly scrollRef: RefObject<ScrollBoxRenderable | null>;
  readonly focused: boolean;
}

interface PointerState {
  readonly clicks: 1 | 2 | 3;
  readonly moved: boolean;
  readonly anchor: SemanticAnchor;
}

interface ClickState {
  readonly at: number;
  readonly anchor: SemanticAnchor;
  readonly count: 1 | 2 | 3;
}

export interface TranscriptSelectionBinding {
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly onMouseDrag: (event: Pick<MouseEvent, "x" | "y">) => void;
  readonly onMouseUp: (event: MouseEvent) => void;
  readonly onMouseDragEnd: () => void;
  handleKey(key: KeyEvent, chord: string): boolean;
}

const MULTI_CLICK_WINDOW_MS = 450;

export function useTranscriptSelection(
  options: TranscriptSelectionOptions,
): TranscriptSelectionBinding {
  const { services, state, spool, scrollRef, focused } = options;
  const documentRef = useRef<SemanticDocument>({ blocks: [] });
  const pointerRef = useRef<PointerState | undefined>(undefined);
  const clickRef = useRef<ClickState | undefined>(undefined);

  const stateRef = useRef(state);
  const builtForRef = useRef<TranscriptState | undefined>(undefined);
  stateRef.current = state;

  // Bounded updates: extracting the semantic document walks the whole
  // transcript, so it is rebuilt on interaction (or while a selection is live)
  // instead of on every streaming delta.
  function ensureDocument(): SemanticDocument {
    const current = stateRef.current;
    if (builtForRef.current === current) return documentRef.current;
    const document = extractTranscriptSemanticDocument(current, {
      toolOutput: (item) => visibleToolOutput(current, spool, item.id, item.toolCallId),
    });
    builtForRef.current = current;
    documentRef.current = document;
    services.selection.setDocument("transcript", document);
    return document;
  }

  useEffect(() => {
    if (!services.selection.hasSelection()) return;
    ensureDocument();
  });

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    return services.selection.registerScrollPort("transcript", {
      startAutoScroll: (x, y) => scroll.startAutoScroll(x, y),
      updateAutoScroll: (x, y) => scroll.updateAutoScroll(x, y),
      stopAutoScroll: () => scroll.stopAutoScroll(),
    });
  }, [services.selection, scrollRef]);

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Keep keyboard with the transcript so ↑/↓ scroll the chat, not history.
    services.focus.focusRegion("transcript");
    // If a child (YOU bubble / tool card) already handled the click, do not
    // start a selection drag that would swallow open-modal handlers.
    if (event.defaultPrevented) return;
    const anchor = anchorAtPointer(ensureDocument(), scrollRef.current, event.x, event.y);
    if (!anchor) return;
    const clicks = nextClickCount(clickRef.current, anchor);
    clickRef.current = { at: Date.now(), anchor, count: clicks };
    pointerRef.current = { clicks, moved: false, anchor };
    const granularity = clicks === 1 ? "character" : clicks === 2 ? "word" : "line";
    services.selection.click("transcript", anchor, granularity);
  }

  function onMouseDrag(event: Pick<MouseEvent, "x" | "y">): void {
    const pointer = pointerRef.current;
    if (!pointer) return;
    if (!pointer.moved) {
      services.selection.beginDrag("transcript", pointer.anchor, event);
    }
    const anchor = anchorAtPointer(documentRef.current, scrollRef.current, event.x, event.y);

    if (anchor) services.selection.dragTo("transcript", anchor, event);
    pointerRef.current = { ...pointer, moved: true };
  }

  function onMouseUp(event: MouseEvent): void {
    if (event.defaultPrevented) {
      pointerRef.current = undefined;
      services.selection.finishDrag();
      return;
    }
    const pointer = pointerRef.current;
    if (!pointer) return;
    services.selection.finishDrag();
    pointerRef.current = undefined;
  }

  function onMouseDragEnd(): void {
    if (!pointerRef.current) return;
    services.selection.finishDrag();
    pointerRef.current = undefined;
  }

  function handleKey(key: KeyEvent, chord: string): boolean {
    if (!focused || services.focus.activeContext() !== "transcript") return false;
    const action = services.router.resolve(chord, "transcript");
    if (!action || !action.startsWith("selection.")) return false;
    // Esc must fall through to the global cancel ladder unless there is
    // actually a selection to clear.
    if (action === "selection.clear" && !services.selection.hasSelection()) {
      return false;
    }
    ensureDocument();
    if (action === "selection.copy") {
      key.preventDefault();
      void services.selection.copy().then((result) => {
        if (result.status === "copied") {
          services.toast.success("Copied to clipboard", {
            key: "clipboard",
            durationMs: 1600,
          });
        } else if (result.status === "empty") {
          services.toast.info("Nothing selected", {
            key: "clipboard",
            durationMs: 1400,
          });
        } else {
          services.toast.error("Copy failed", { key: "clipboard", durationMs: 2200 });
        }
      });
      return true;
    }
    if (!services.selection.handleAction(action, "transcript")) return false;
    if (action === "selection.select-all") {
      services.toast.info("Transcript selected · Ctrl+Shift+C to copy", {
        key: "selection",
        durationMs: 1800,
      });
    }
    key.preventDefault();
    return true;
  }

  return { onMouseDown, onMouseDrag, onMouseUp, onMouseDragEnd, handleKey };
}

function visibleToolOutput(
  state: TranscriptState,
  spool: OutputSpool,
  itemId: string,
  toolCallId: Parameters<OutputSpool["tail"]>[0],
): string | undefined {
  const tail = spool.tail(toolCallId);
  if (!tail) return undefined;
  const item = state.byId.get(itemId);
  if (item?.kind === "tool" && isItemExpanded(state, item)) return tail;
  return tail.split("\n").slice(-4).join("\n");
}

function anchorAtPointer(
  document: SemanticDocument,
  scroll: ScrollBoxRenderable | null,
  x: number,
  y: number,
): SemanticAnchor | undefined {
  // Resolve every mounted block renderable in ONE depth-first pass over the
  // (viewport-culled) tree instead of a per-block findDescendantById walk —
  // 4k blocks × O(tree) per mouse-move was the drag-lag bottleneck. Blocks are
  // in document (source) order, which matches their vertical layout order in
  // the transcript column, so no sort is needed.
  const renderableById = new Map<string, Renderable>();
  collectVisibleRenderables(scroll, renderableById);

  let firstVisible: { block: SemanticDocument["blocks"][number]; renderable: Renderable } | undefined;
  let lastVisible: { block: SemanticDocument["blocks"][number]; renderable: Renderable } | undefined;
  let nearestAbove: { block: SemanticDocument["blocks"][number]; renderable: Renderable } | undefined;
  let nearestBelow: { block: SemanticDocument["blocks"][number]; renderable: Renderable } | undefined;

  for (const block of document.blocks) {
    const renderable = renderableById.get(block.id);
    if (!renderable) continue;
    const top = renderable.screenY;
    const bottom = top + renderable.height;
    if (!firstVisible) firstVisible = { block, renderable };
    lastVisible = { block, renderable };
    if (y >= top && y < bottom) return anchorForPoint(block, renderable, x, y);
    if (bottom <= y) nearestAbove = { block, renderable };
    if (top > y && !nearestBelow) nearestBelow = { block, renderable };
  }

  if (!firstVisible || !lastVisible) return documentStart(document);
  if (y < firstVisible.renderable.screenY) return { blockId: firstVisible.block.id, offset: 0 };
  if (y >= lastVisible.renderable.screenY + lastVisible.renderable.height) {
    return { blockId: lastVisible.block.id, offset: lastVisible.block.text.length };
  }
  const above = nearestAbove ?? firstVisible;
  const below = nearestBelow ?? lastVisible;
  const distAbove = Math.abs(y - (above.renderable.screenY + above.renderable.height));
  const distBelow = Math.abs(y - below.renderable.screenY);
  if (distAbove <= distBelow) {
    return { blockId: above.block.id, offset: above.block.text.length };
  }
  return { blockId: below.block.id, offset: 0 };
}

function collectVisibleRenderables(
  node: ScrollBoxRenderable | Renderable | null,
  out: Map<string, Renderable>,
): void {
  if (!node) return;
  if (node.id && node.visible) out.set(node.id, node);
  const children = node.getChildren();
  for (const child of children) {
    collectVisibleRenderables(child as Renderable, out);
  }
}

function anchorForPoint(
  block: SemanticDocument["blocks"][number],
  renderable: Renderable,
  x: number,
  y: number,
): SemanticAnchor {
  const line = Math.max(0, Math.round(y - renderable.screenY));
  const column = Math.max(0, Math.round(x - renderable.screenX));
  const lines = block.text.split("\n");
  const selectedLine = Math.min(line, Math.max(0, lines.length - 1));
  const before = lines.slice(0, selectedLine).reduce((total, value) => total + value.length + 1, 0);
  const offset = Math.min(before + column, before + (lines[selectedLine]?.length ?? 0));
  return { blockId: block.id, offset };
}

function nextClickCount(previous: ClickState | undefined, anchor: SemanticAnchor): 1 | 2 | 3 {
  if (!previous || Date.now() - previous.at > MULTI_CLICK_WINDOW_MS) return 1;
  const sameBlock = previous.anchor.blockId === anchor.blockId;
  const closeEnough = sameBlock && Math.abs(previous.anchor.offset - anchor.offset) <= 2;
  if (!closeEnough) return 1;
  return Math.min(3, previous.count + 1) as 1 | 2 | 3;
}
