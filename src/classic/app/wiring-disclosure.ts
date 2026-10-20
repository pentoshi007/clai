import { disclosureAtPointer } from "../feed/transcript-disclosure.js";
import { openToolOutputPager } from "../../ui-core/rendering/open-tool-output.js";
import type { MouseEvent } from "../input/key-event.js";
import type { WiringHost } from "./wiring-types.js";

const pressed = new WeakSet<WiringHost>();

export function handleDisclosureMouse(host: WiringHost, event: MouseEvent): boolean {
  if (pressed.has(host) && (event.release || event.drag)) {
    if (event.release) pressed.delete(host);
    return true;
  }
  if (event.scroll || event.release || event.drag || event.button !== "left") return false;
  pressed.delete(host);
  if (host.panels.isOpen() || host.contextLimitEditingValue || !host.selectionWindow) return false;
  const target = disclosureAtPointer(host.selectionWindow, event.x, event.y, host.selectionGeometry);
  if (!target) return false;
  pressed.add(host);
  host.selectionPointerCell = undefined;
  host.selectionPointerMoved = false;
  if (target.action === "output") {
    const item = host.services.transcript.getState().byId.get(target.itemId);
    if (item?.kind === "tool") void openToolOutputPager(host.services, item);
  } else host.revealItem(target.itemId);
  host.schedulePaint(true);
  return true;
}
