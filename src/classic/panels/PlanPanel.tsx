import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { planView, type PlanViewInput } from "./plan-panel.js";

export function PlanPanel(props: PlanViewInput): ReactNode {
  return <PanelFrame {...planView(props)} />;
}
