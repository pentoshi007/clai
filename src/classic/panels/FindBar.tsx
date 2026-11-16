import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { findBarView, type FindBarInput } from "./find-bar.js";

export function FindBar(props: FindBarInput): ReactNode {
  return <PanelFrame {...findBarView(props)} />;
}
