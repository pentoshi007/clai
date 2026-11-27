import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { questionView, type QuestionViewInput } from "./question-panel.js";

export function QuestionPanel(props: QuestionViewInput): ReactNode {
  return <PanelFrame {...questionView(props)} />;
}
