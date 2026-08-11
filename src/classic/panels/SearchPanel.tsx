import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { searchView, type SearchViewInput } from "./search-panel.js";

export function SearchPanel(props: SearchViewInput): ReactNode {
  return <PanelFrame {...searchView(props)} />;
}
