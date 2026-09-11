import type { PickerOption } from "./picker-filter.js";
import { wrapPagerLine } from "./pager-chrome.js";
import { renderColumns } from "./text-width.js";

export interface PickerLine {
  readonly text: string;
  readonly description: boolean;
}

export interface PickerItemLayout {
  readonly lines: readonly PickerLine[];
  readonly top: number;
  readonly height: number;
}

const lineCache = new WeakMap<PickerOption, {
  width: number;
  twoLine: boolean;
  lines: readonly PickerLine[];
}>();

export function layoutPickerOptions(
  options: readonly PickerOption[],
  width: number,
  twoLine: boolean,
): readonly PickerItemLayout[] {
  const textWidth = Math.max(1, width - (width >= 3 ? 2 : 0));
  let top = 0;
  return options.map((option) => {
    const cached = lineCache.get(option);
    if (cached?.width === width && cached.twoLine === twoLine) {
      const item = { lines: cached.lines, top, height: cached.lines.length };
      top += item.height;
      return item;
    }
    const iconPrefix = option.icon ? `${option.icon} ` : "";
    const descriptionPad = " ".repeat(renderColumns(iconPrefix));
    const label = `${iconPrefix}${option.label}${option.active ? " · current" : ""}`;
    const wrap = (text: string, description: boolean): PickerLine[] =>
      text.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
        const pad = description ? descriptionPad : "";
        return wrapPagerLine(line, Math.max(1, textWidth - pad.length), { preserveWhitespace: true })
          .map((text) => ({ text: `${pad}${text}`, description }));
      });
    const lines = twoLine
      ? [...wrap(label, false), ...wrap(option.description ?? "", true)]
      : wrap(`${label}${option.description ? `  ${option.description}` : ""}`, false);
    const item = { lines, top, height: lines.length };
    lineCache.set(option, { width, twoLine, lines });
    top += item.height;
    return item;
  });
}

export function pickerScrollTop(
  items: readonly PickerItemLayout[],
  selected: number,
  height: number,
  previousTop: number,
): number {
  const item = items[selected];
  const last = items.at(-1);
  const max = Math.max(0, (last ? last.top + last.height : 0) - height);
  let top = Math.max(0, Math.min(previousTop, max));
  if (item && (item.top + item.height <= top || item.top >= top + height)) top = item.top;
  return Math.min(top, max);
}

export function pickerItemAtRow(items: readonly PickerItemLayout[], row: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const item = items[middle]!;
    if (item.top + item.height <= row) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, items.length - 1);
}

export function pickerWindow(
  items: readonly PickerItemLayout[],
  top: number,
  height: number,
  overscan = 2,
): {
  before: number;
  after: number;
  rows: Array<{ itemIndex: number; lineIndex: number; line: PickerLine }>;
} {
  const last = items.at(-1);
  const total = last ? last.top + last.height : 0;
  const viewport = Math.max(1, Math.floor(height));
  const start = Math.max(0, Math.min(Math.floor(top), total - viewport));
  const before = Math.max(0, start - overscan);
  const end = Math.min(total, start + viewport + overscan);
  const rows: Array<{ itemIndex: number; lineIndex: number; line: PickerLine }> = [];
  for (let itemIndex = Math.max(0, pickerItemAtRow(items, before)); itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]!;
    if (item.top >= end) break;
    const firstLine = Math.max(0, before - item.top);
    const lastLine = Math.min(item.height, end - item.top);
    for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex++) {
      rows.push({ itemIndex, lineIndex, line: item.lines[lineIndex]! });
    }
  }
  return { before, after: total - end, rows };
}
