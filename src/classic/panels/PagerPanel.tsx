import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { pagerView, type PagerViewInput } from "./pager-panel.js";

export function PagerPanel(props: PagerViewInput): ReactNode {
  return <PanelFrame {...pagerView(props)} />;
}
