import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { textEditorView, type TextEditorViewInput } from "./text-editor-panel.js";

export function TextEditorPanel(props: TextEditorViewInput): ReactNode {
  return <PanelFrame {...textEditorView(props)} />;
}
