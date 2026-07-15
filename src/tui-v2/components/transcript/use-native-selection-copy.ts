/** @jsxImportSource @opentui/react */
/**
 * OpenTUI native selection: copy on mouse release, toast, stop edge-scroll.
 *
 * Selectable text includes response body, thinking body, YOU prompt body,
 * tool output, and notices. Interactive chrome uses click-without-drag so
 * short clicks still open modals while drag-select works on the same nodes.
 */

import { useRenderer, useSelectionHandler } from "@opentui/react";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { transcriptScrollPort } from "./transcript-scroll-port.js";

export function useNativeSelectionCopy(services: AppServices): void {
  const renderer = useRenderer();

  useSelectionHandler((selection) => {
    // While dragging, App/ScrollBox keep edge-autoscroll alive.
    if (selection.isDragging) return;

    transcriptScrollPort.stopAutoScroll();

    const text = selection.getSelectedText().replace(/\r\n/g, "\n").trimEnd();
    if (!text.trim()) return;

    void services.ports.clipboard.writeText(text).then(
      () => {
        services.toast.show("Copied to clipboard", {
          level: "success",
          durationMs: 2000,
        });
        try {
          renderer.clearSelection();
        } catch {
          /* ignore */
        }
      },
      () => {
        services.toast.show("Copy failed", { level: "error", durationMs: 2500 });
      },
    );
  });
}
