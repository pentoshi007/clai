/**
 * Click vs drag-select: open modals only when the pointer barely moved.
 *
 * OpenTUI starts selection on mouse-down over selectable text with
 * `isDragging=true` immediately, so we cannot rely on that flag. A small
 * movement threshold distinguishes a real drag-select from a click.
 */

import { useRef } from "react";
import type { MouseEvent } from "@opentui/core";

const CLICK_SLOP = 2;

export interface ClickWithoutDragHandlers {
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly onMouseUp: (event: MouseEvent) => void;
}

export function useClickWithoutDrag(onClick: () => void): ClickWithoutDragHandlers {
  const downRef = useRef<{ x: number; y: number } | undefined>(undefined);

  return {
    onMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return;
      downRef.current = { x: event.x, y: event.y };
    },
    onMouseUp(event: MouseEvent): void {
      if (event.button !== 0) return;
      const start = downRef.current;
      downRef.current = undefined;
      if (!start) return;
      if (
        Math.abs(event.x - start.x) > CLICK_SLOP ||
        Math.abs(event.y - start.y) > CLICK_SLOP
      ) {
        return; // drag-select — do not open
      }
      event.preventDefault();
      event.stopPropagation();
      onClick();
    },
  };
}
