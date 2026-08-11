import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { jobsView, type JobsViewInput } from "./jobs-panel.js";

export function JobsPanel(props: JobsViewInput): ReactNode {
  return <PanelFrame {...jobsView(props)} />;
}
