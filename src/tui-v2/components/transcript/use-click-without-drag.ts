
import { useRef } from "react";
import type { MouseEvent } from "@opentui/core";

const CLICK_SLOP = 4;

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
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClick();
    },
  };
}
