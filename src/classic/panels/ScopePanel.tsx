import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { scopeView, type ScopeViewInput } from "./scope-panel.js";

export function ScopePanel(props: ScopeViewInput): ReactNode {
  return <PanelFrame {...scopeView(props)} />;
}
