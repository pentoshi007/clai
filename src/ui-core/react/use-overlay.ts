/** React binding for `OverlayController`, mirroring `use-transcript-store.ts`. */

import { useSyncExternalStore } from "react";
import type { OverlayController, OverlayState } from "../controllers/overlay-controller.js";

export function useOverlayState(controller: OverlayController): OverlayState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
  );
}
