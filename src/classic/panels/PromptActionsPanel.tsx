import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import {
  promptActionsView,
  type PromptActionsViewInput,
} from "./prompt-actions-panel.js";

export function PromptActionsPanel(props: PromptActionsViewInput): ReactNode {
  return <PanelFrame {...promptActionsView(props)} />;
}
