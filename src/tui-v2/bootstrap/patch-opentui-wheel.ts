import { TextBufferRenderable } from "@opentui/core";

let patched = false;

type TextMouseHandler = (this: TextBufferRenderable, event: { type: string }) => void;

/**
 * OpenTUI delivers a wheel event to the renderable under the pointer before its
 * ancestors, and a text renderable scrolls its own viewport while handling it.
 * Text clipped to one row (artifact paths, diff headers) therefore jumps to its
 * last wrapped line the moment the transcript scrolls, cutting the head of the
 * line. Scrolling belongs to the enclosing scrollbox, so text ignores it and
 * lets the event bubble.
 */
export function patchOpenTuiWheelScroll(): void {
  if (patched) return;
  patched = true;

  const proto = TextBufferRenderable.prototype as unknown as {
    onMouseEvent: TextMouseHandler;
  };
  const onMouseEvent = proto.onMouseEvent;
  proto.onMouseEvent = function (event) {
    if (event.type === "scroll") return;
    onMouseEvent.call(this, event);
  };
}
