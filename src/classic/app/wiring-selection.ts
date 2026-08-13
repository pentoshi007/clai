import { notify } from "../../ui-core/notify.js";
import type { MouseEvent } from "../input/key-event.js";
import { anchorAtTranscriptPointer } from "../feed/transcript-selection.js";
import { WHEEL_SCROLL_ROWS } from "./wiring-interactions.js";
import type { WiringHost } from "./wiring-types.js";

function stopAutoScroll(host: WiringHost): void {
  if (!host.selectionAutoScrollTimer) return;
  clearInterval(host.selectionAutoScrollTimer);
  host.selectionAutoScrollTimer = undefined;
}

function updateAutoScroll(host: WiringHost): void {
  const window = host.selectionWindow;
  if (!window || !host.selectionPointerAnchor || !host.selectionPointerMoved) return;
  const relativeY = host.selectionPointerY - host.selectionGeometry.top;
  if (relativeY <= 0) host.scrollFeed(WHEEL_SCROLL_ROWS);
  else if (relativeY >= window.viewportRows) host.scrollFeed(-WHEEL_SCROLL_ROWS);
  else return;
  const anchor = anchorAtTranscriptPointer(
    window,
    host.selectionPointerX,
    host.selectionPointerY,
    host.selectionGeometry,
    true,
  );
  if (!anchor) return;
  host.services.selection.dragTo("transcript", anchor, {
    x: host.selectionPointerX,
    y: host.selectionPointerY,
  });
  host.schedulePaint();
}

function ensureAutoScroll(host: WiringHost): void {
  const window = host.selectionWindow;
  if (!window || !host.selectionPointerMoved) return;
  const relativeY = host.selectionPointerY - host.selectionGeometry.top;
  if (relativeY > 0 && relativeY < window.viewportRows) {
    stopAutoScroll(host);
    return;
  }
  if (host.selectionAutoScrollTimer) return;
  host.selectionAutoScrollTimer = setInterval(() => updateAutoScroll(host), 50);
  host.selectionAutoScrollTimer.unref?.();
}

async function copySelection(host: WiringHost): Promise<void> {
  const result = await host.services.selection.copy();
  if (result.status === "copied") {
    notify(host.services, "Copied selection", { level: "success", key: "copy", durationMs: 1800 });
  } else if (result.status === "empty") {
    notify(host.services, "Nothing to copy", { key: "copy", durationMs: 1800 });
  } else {
    notify(host.services, "Copy failed", { level: "warn", key: "copy", durationMs: 1800 });
  }
}

export function handleTranscriptMouse(host: WiringHost, event: MouseEvent): void {
  if (event.scroll === "up" || event.scroll === "down") {
    if (host.panels.isOpen()) {
      host.panels.handleWheel(event.scroll === "down" ? 1 : -1, WHEEL_SCROLL_ROWS);
      host.schedulePaint();
      return;
    }
    host.scrollFeed(event.scroll === "up" ? WHEEL_SCROLL_ROWS : -WHEEL_SCROLL_ROWS);
    return;
  }
  const window = host.selectionWindow;
  if (!window || host.panels.isOpen()) {
    stopAutoScroll(host);
    return;
  }
  host.selectionPointerX = event.x;
  host.selectionPointerY = event.y;
  const anchor = anchorAtTranscriptPointer(
    window,
    event.x,
    event.y,
    host.selectionGeometry,
    host.selectionPointerAnchor !== undefined,
  );
  if (event.release) {
    const shouldCopy = host.selectionPointerAnchor !== undefined && host.selectionPointerMoved;
    if (host.selectionPointerAnchor && anchor) {
      if (host.selectionPointerMoved) host.services.selection.dragTo("transcript", anchor, event);
      host.services.selection.finishDrag();
    }
    stopAutoScroll(host);
    host.selectionPointerAnchor = undefined;
    host.selectionPointerMoved = false;
    if (shouldCopy && host.services.selection.hasSelection()) void copySelection(host);
    if (shouldCopy) host.services.focus.focusRegion("composer");
    host.schedulePaint();
    return;
  }
  if (event.button !== "left" || !anchor) return;
  host.services.focus.focusRegion("transcript");
  if (!event.drag) {
    stopAutoScroll(host);
    host.selectionPointerAnchor = anchor;
    host.selectionPointerMoved = false;
    host.services.selection.click("transcript", anchor);
    host.schedulePaint();
    return;
  }
  if (!host.selectionPointerAnchor) return;
  if (!host.selectionPointerMoved) {
    host.services.selection.beginDrag("transcript", host.selectionPointerAnchor, event);
  }
  host.services.selection.dragTo("transcript", anchor, event);
  host.selectionPointerMoved = true;
  ensureAutoScroll(host);
  updateAutoScroll(host);
  host.schedulePaint();
}
