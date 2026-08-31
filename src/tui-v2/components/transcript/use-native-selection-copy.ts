/** @jsxImportSource @opentui/react */

import { useRenderer, useSelectionHandler } from "@opentui/react";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { transcriptScrollPort } from "./transcript-scroll-port.js";

export function useNativeSelectionCopy(services: AppServices): void {
  const renderer = useRenderer();

  useSelectionHandler((selection) => {
    if (selection.isDragging) return;

    transcriptScrollPort.stopAutoScroll();

    const text = selection.getSelectedText().replace(/\r\n/g, "\n").trimEnd();
    if (!text.trim()) return;

    void services.ports.clipboard.writeText(text).then(
      () => {
        services.toast.success("Copied to clipboard", {
          key: "clipboard",
          durationMs: 1600,
        });
        try {
          renderer.clearSelection();
        } catch {
        }
      },
      () => {
        services.toast.error("Copy failed", {
          key: "clipboard",
          durationMs: 2200,
        });
      },
    );
  });
}
