/** React subscription hook for ToastController. */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ToastController, ToastItem } from "../controllers/toast-controller.js";

export function useToastState(toast: ToastController): readonly ToastItem[] {
  // Cache snapshot so useSyncExternalStore only re-renders when the toast
  // list identity changes (ToastController replaces the array on mutate).
  const cache = useRef<readonly ToastItem[]>(toast.getToasts());
  const getSnapshot = useCallback(() => {
    const next = toast.getToasts();
    if (next !== cache.current) cache.current = next;
    return cache.current;
  }, [toast]);
  return useSyncExternalStore(
    (onStoreChange) => toast.subscribe(onStoreChange),
    getSnapshot,
    getSnapshot,
  );
}
