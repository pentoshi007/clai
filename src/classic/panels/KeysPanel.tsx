import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { keysView, type KeysViewInput } from "./keys-panel.js";

export function KeysPanel(props: KeysViewInput): ReactNode {
  return <PanelFrame {...keysView(props)} />;
}
