import { BoxRenderable, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { extend } from "@opentui/react";

export class TaskTitleRenderable extends BoxRenderable {
  protected override _getVisibleChildren(): number[] {
    let ancestor: Renderable | null = this.parent;
    while (ancestor && !(ancestor instanceof ScrollBoxRenderable)) ancestor = ancestor.parent;
    if (!ancestor) return super._getVisibleChildren();
    const viewport = ancestor.viewport;
    const fits = this.height <= viewport.height;
    const clipped = this.y < viewport.y || this.y + this.height > viewport.y + viewport.height;
    return fits && clipped ? [] : super._getVisibleChildren();
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "task-title": typeof TaskTitleRenderable;
  }
}

extend({ "task-title": TaskTitleRenderable });
