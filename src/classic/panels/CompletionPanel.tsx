import type { ReactNode } from "react";
import { completionView, type CompletionViewInput } from "./completion-rows.js";
import { PanelFrame } from "./PanelFrame.js";

export function CompletionPanel(props: CompletionViewInput): ReactNode {
  const view = completionView(props);
  if (!view) return null;
  return <PanelFrame {...view.frame} />;
}
