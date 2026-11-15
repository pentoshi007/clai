/** @jsxImportSource @opentui/react */

import { useSelectionHandler } from "@opentui/react";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { transcriptScrollPort } from "./transcript-scroll-port.js";
import { copyableSelectionText } from "../../../ui-core/rendering/code-block-copy.js";

export function useNativeSelectionCopy(services: AppServices): void {
  useSelectionHandler((selection) => {
    if (selection.isDragging) return;

    transcriptScrollPort.stopAutoScroll();

    const text = copyableSelectionText(selection.getSelectedText().replace(/\r\n/g, "\n")).trimEnd();
    if (!text.trim()) return;

    void services.ports.clipboard.writeText(text).then(
      () => {
        services.toast.success("Copied to clipboard", {
          key: "clipboard",
          durationMs: 1600,
        });
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
