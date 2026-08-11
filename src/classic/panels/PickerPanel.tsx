import type { ReactNode } from "react";
import { PanelFrame } from "./PanelFrame.js";
import { pickerView, type PickerViewInput } from "./picker-panel.js";

export function PickerPanel(props: PickerViewInput): ReactNode {
  return <PanelFrame {...pickerView(props).frame} />;
}
