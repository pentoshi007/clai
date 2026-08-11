import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { secretView, type SecretViewInput } from "./secret-panel.js";

export function SecretPanel(props: SecretViewInput): ReactNode {
  return <PanelFrame {...secretView(props)} />;
}
