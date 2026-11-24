/** @jsxImportSource @opentui/react */

import { useRenderer, useSelectionHandler } from "@opentui/react";
import type { KeyEvent, Selection } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { copyableSelectionText } from "../../../ui-core/rendering/code-block-copy.js";
import { isCellSelection, selectedCellText } from "./table-cell-selection.js";
import { transcriptScrollPort } from "./transcript-scroll-port.js";

function copySelection(services: AppServices, selection: Selection): void {
  const text = selectedCellText(selection) ?? copyableSelectionText(selection.getSelectedText().replace(/\r\n/g, "\n")).trimEnd();
  if (!text.trim()) return;
  void services.ports.clipboard.writeText(text).then(
    () => services.toast.success("Copied to clipboard", { key: "clipboard", durationMs: 1600 }),
    () => services.toast.error("Copy failed", { key: "clipboard", durationMs: 2200 }),
  );
}

export function useNativeSelectionCopy(services: AppServices) {
  const renderer = useRenderer();
  useSelectionHandler(selection => {
    if (selection.isDragging) return;
    transcriptScrollPort.stopAutoScroll();
    copySelection(services, selection);
  });
  return (key: KeyEvent, chord: string): boolean => {
    const selection = renderer.getSelection();
    if (!isCellSelection(selection) || services.focus.activeContext() !== "transcript") return false;
    const action = services.router.resolve(chord, "transcript");
    if (action === "selection.copy") {
      key.preventDefault();
      copySelection(services, selection);
      return true;
    }
    if (action?.startsWith("selection.")) renderer.clearSelection();
    return false;
  };
}
