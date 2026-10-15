import type { MouseEvent } from "../input/key-event.js";
import { cancelTranscriptPointer } from "./wiring-selection.js";
import type { WiringHost } from "./wiring-types.js";

type HitRegion = NonNullable<WiringHost["jumpToLatestHitRegion"]>;
const pressed = new WeakMap<WiringHost, { readonly region: HitRegion; moved: boolean }>();

export function handleJumpToLatestMouse(host: WiringHost, event: MouseEvent): boolean {
  const region = host.jumpToLatestHitRegion;
  if (!region || host.panels.isOpen() || host.services.focus.hasOverlay() || host.services.focus.inputCaptured) {
    pressed.delete(host);
    return false;
  }
  if (event.scroll || event.button !== "left") return false;
  const inside = event.y === region.top && event.x >= region.left && event.x < region.left + region.width;
  const pending = pressed.get(host);
  if (event.release) {
    pressed.delete(host);
    if (!pending) return false;
    const unchanged = pending.region.left === region.left && pending.region.top === region.top && pending.region.width === region.width;
    if (inside && unchanged && !pending.moved) {
      cancelTranscriptPointer(host);
      host.scrollFeed(-Number.MAX_SAFE_INTEGER);
      host.services.focus.focusRegion("composer");
    }
    return true;
  }
  if (event.drag) {
    if (!pending) return false;
    pending.moved = true;
    return true;
  }
  pressed.delete(host);
  if (!inside) return false;
  cancelTranscriptPointer(host);
  pressed.set(host, { region, moved: false });
  return true;
}
