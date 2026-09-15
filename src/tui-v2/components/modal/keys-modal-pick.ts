import type { KeysEditorAnswer } from "../../../ui-core/controllers/overlay-controller.js";

export interface KeysModalPickRow {
  readonly slotId?: string | undefined;
  readonly placeholder: string;
  readonly text: string;
  readonly disabled: boolean;
}

export function buildKeysPickerAnswer(
  rows: readonly KeysModalPickRow[],
  activeIndex: number,
): KeysEditorAnswer {
  return {
    action: "pick",
    rows: rows.map((row) => ({
      ...(row.slotId ? { slotId: row.slotId } : {}),
      value: row.text.trim() || row.placeholder,
      disabled: row.disabled,
    })),
    activeIndex,
  };
}

export function keysAddAtCapacity(
  rows: readonly KeysModalPickRow[],
  maxRows: number,
): boolean {
  return rows.filter((row) => row.slotId !== undefined || row.text.trim().length > 0).length >= maxRows;
}
