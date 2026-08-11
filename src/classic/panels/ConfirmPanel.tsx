import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { confirmView, type ConfirmViewInput } from "./confirm-panel.js";

export function ConfirmPanel(props: ConfirmViewInput): ReactNode {
  return <PanelFrame {...confirmView(props)} />;
}
