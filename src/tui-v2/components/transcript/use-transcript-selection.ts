/** @jsxImportSource @opentui/react */
/** Renderer adapter for the pure pane-scoped selection controller. */

import { useEffect, useRef, type RefObject } from "react";
import type { KeyEvent, MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import {
  documentEnd,
  documentStart,
  type SemanticAnchor,
  type SemanticDocument,
} from "../../state/semantic-document.js";
import { isItemExpanded, type TranscriptState } from "../../state/transcript-types.js";
import { extractTranscriptSemanticDocument } from "../../rendering/transcript-semantic.js";

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
}

interface ClickState {
  readonly at: number;
  readonly anchor: SemanticAnchor;
  readonly count: 1 | 2 | 3;
}

export interface TranscriptSelectionBinding {
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly onMouseDrag: (event: MouseEvent) => void;
  readonly onMouseUp: (event: MouseEvent) => void;
  readonly onMouseDragEnd: (event: MouseEvent) => void;
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

  useEffect(() => {
    const document = extractTranscriptSemanticDocument(state, {
      toolOutput: (item) => visibleToolOutput(state, spool, item.id, item.toolCallId),
    });
    documentRef.current = document;
    services.selection.setDocument("transcript", document);
  }, [services.selection, spool, state]);

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
    const anchor = anchorAtPointer(documentRef.current, scrollRef.current, event.x, event.y);
    if (!anchor) return;
    const clicks = nextClickCount(clickRef.current, anchor);
    clickRef.current = { at: Date.now(), anchor, count: clicks };
    pointerRef.current = { clicks, moved: false };
    services.selection.beginDrag("transcript", anchor, event);
  }

  function onMouseDrag(event: MouseEvent): void {
    const pointer = pointerRef.current;
    if (!pointer) return;
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
    const anchor = anchorAtPointer(documentRef.current, scrollRef.current, event.x, event.y);
    if (!pointer.moved && anchor) {
      const granularity = pointer.clicks === 1 ? "character" : pointer.clicks === 2 ? "word" : "line";
      services.selection.click("transcript", anchor, granularity);
    }
    services.selection.finishDrag();
    pointerRef.current = undefined;
  }

  function onMouseDragEnd(_event: MouseEvent): void {
    if (!pointerRef.current) return;
    services.selection.finishDrag();
    pointerRef.current = undefined;
  }

  function handleKey(key: KeyEvent, chord: string): boolean {
    if (!focused || services.focus.activeContext() !== "transcript") return false;
    const action = services.router.resolve(chord, "transcript");
    if (!action || !services.selection.handleAction(action, "transcript")) return false;
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
  const visible = document.blocks
    .map((block) => ({ block, renderable: scroll?.findDescendantById(block.id) }))
    .filter((entry): entry is { block: SemanticDocument["blocks"][number]; renderable: Renderable } =>
      Boolean(entry.renderable && entry.renderable.visible),
    )
    .sort((left, right) => left.renderable.screenY - right.renderable.screenY);

  for (const entry of visible) {
    const { renderable } = entry;
    if (y >= renderable.screenY && y < renderable.screenY + renderable.height) {
      return anchorForPoint(entry.block, renderable, x, y);
    }
  }
  if (visible.length === 0) return documentStart(document);
  const first = visible[0]!;
  const last = visible.at(-1)!;
  if (y < first.renderable.screenY) return { blockId: first.block.id, offset: 0 };
  if (y >= last.renderable.screenY + last.renderable.height) {
    return { blockId: last.block.id, offset: last.block.text.length };
  }
  return documentEnd(document);
}

function anchorForPoint(
  block: SemanticDocument["blocks"][number],
  renderable: Renderable,
  x: number,
  y: number,
): SemanticAnchor {
  const line = Math.max(0, Math.floor(y - renderable.screenY));
  const column = Math.max(0, Math.floor(x - renderable.screenX));
  const lines = block.text.split("\n");
  const selectedLine = Math.min(line, Math.max(0, lines.length - 1));
  const before = lines.slice(0, selectedLine).reduce((total, value) => total + value.length + 1, 0);
  const offset = Math.min(before + column, before + (lines[selectedLine]?.length ?? 0));
  return { blockId: block.id, offset };
}

function nextClickCount(previous: ClickState | undefined, anchor: SemanticAnchor): 1 | 2 | 3 {
  const samePoint = previous?.anchor.blockId === anchor.blockId && previous.anchor.offset === anchor.offset;
  if (!samePoint || !previous || Date.now() - previous.at > MULTI_CLICK_WINDOW_MS) return 1;
  return Math.min(3, previous.count + 1) as 1 | 2 | 3;
}
