import { composerCursorAtPointer } from "../chrome/composer-pointer.js";
import type { MouseEvent } from "../input/key-event.js";
import { cancelTranscriptPointer } from "./wiring-selection.js";
import type { WiringHost } from "./wiring-types.js";

export function handleComposerMouse(host: WiringHost, event: MouseEvent): boolean {
  if (event.scroll || event.button !== "left" || host.panels.isOpen() || host.services.focus.hasOverlay() || host.services.focus.inputCaptured) return false;
  const view = host.composerPointerView;
  const geometry = host.composerPointerGeometry;
  if (!view || !geometry) return false;
  const cursor = composerCursorAtPointer(view, geometry, event.x, event.y);
  if (cursor === undefined) return false;
  if (event.release || event.drag) return true;
  cancelTranscriptPointer(host);
  host.services.focus.focusRegion("composer");
  if (view.state.text === host.composer.text) host.composer.setCursor(cursor);
  host.schedulePaint(true);
  return true;
}
