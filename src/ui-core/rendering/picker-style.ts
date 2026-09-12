import type { PickerOptionTone } from "./picker-filter.js";
import type { Theme } from "./theme.js";

export function pickerToneColor(tone: PickerOptionTone | undefined, theme: Theme): string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warn":
      return theme.activity;
    case "error":
      return theme.diffDel;
    case "muted":
      return theme.muted;
    default:
      return theme.accent;
  }
}
