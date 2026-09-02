import { extname } from "node:path";
import type { CommandDefinition } from "../../app/commands/command.js";
import type { CompletionMenu } from "../../ui-core/composer/completion.js";
import type { FileSuggestion } from "../../ui/mentions.js";
import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";

export const COMPLETION_MIN_ROWS = 6;
export const COMPLETION_MAX_ROWS = 12;
export const COMPLETION_BORDER_ROWS = 2;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".ico",
  ".heic",
]);

export function completionRowsWanted(terminalRows: number): number {
  const third = Math.floor(Math.max(0, terminalRows) / 3);
  return Math.max(COMPLETION_MIN_ROWS, Math.min(third, COMPLETION_MAX_ROWS));
}

export function completionOverlayRows(terminalRows: number): number {
  return completionRowsWanted(terminalRows) + COMPLETION_BORDER_ROWS;
}

export function isImageSuggestion(suggestion: FileSuggestion): boolean {
  return !suggestion.isDir && IMAGE_EXTENSIONS.has(extname(suggestion.value).toLowerCase());
}

export function sortSuggestions(
  suggestions: readonly FileSuggestion[],
): readonly FileSuggestion[] {
  const dirs = suggestions.filter((entry) => entry.isDir);
  const files = suggestions.filter((entry) => !entry.isDir);
  return [...dirs, ...files];
}

export function commandLabel(command: CommandDefinition): string {
  const aliases = command.aliases ?? [];
  const names = [command.name, ...aliases].map((name) => `/${name}`);
  return names.join(", ");
}

export function completionCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (prefix === "") break;
  }
  return prefix;
}

export interface CompletionViewInput {
  readonly ink: InkTheme;
  readonly menu: CompletionMenu;
  readonly active: number;
  readonly columns: number;
  readonly rows: number;
  readonly previousTop?: number | undefined;
}

export interface CompletionView {
  readonly frame: PanelFrameInput;
  readonly top: number;
  readonly count: number;
}

function twoColumnRow(
  ink: InkTheme,
  marker: string,
  left: string,
  right: string,
  width: number,
  activeRow: boolean,
): string {
  const rightWidth = right === "" ? 0 : layoutWidth(right) + 2;
  const leftWidth = Math.max(1, width - 2 - rightWidth);
  const label = padToWidth(clipToWidth(left, leftWidth, ink.glyphs.ellipsis), leftWidth);
  const painted = activeRow ? ink.bold(label) : label;
  const tail = right === "" ? "" : `  ${right}`;
  return sealStyle(`${marker}${painted}${tail}`);
}

function slashRows(input: CompletionViewInput, items: readonly CommandDefinition[]): string[] {
  const { ink } = input;
  const width = panelBodyWidth(input.columns);
  return items.map((command, index) => {
    const activeRow = index === input.active;
    const marker = activeRow ? ink.fg("inputBorder", `${ink.glyphs.promptMark} `) : "  ";
    const right = command.usage ? command.usage : command.description;
    return twoColumnRow(
      ink,
      marker,
      ink.fg("accent", commandLabel(command)),
      ink.fg("muted", right),
      width,
      activeRow,
    );
  });
}

function mentionRows(input: CompletionViewInput, items: readonly FileSuggestion[]): string[] {
  const { ink } = input;
  const width = panelBodyWidth(input.columns);
  return items.map((suggestion, index) => {
    const activeRow = index === input.active;
    const marker = activeRow ? ink.fg("inputBorder", `${ink.glyphs.promptMark} `) : "  ";
    const tag = suggestion.isDir
      ? ink.fg("muted", "dir")
      : isImageSuggestion(suggestion)
        ? ink.fg("magenta", "[img]")
        : "";
    return twoColumnRow(ink, marker, suggestion.label, tag, width, activeRow);
  });
}

export function completionItemValues(menu: CompletionMenu): readonly string[] {
  if (menu.kind === "slash") return menu.items.map((item) => `/${item.name}`);
  if (menu.kind === "mention") return sortSuggestions(menu.items).map((item) => item.value);
  return [];
}

export function completionView(input: CompletionViewInput): CompletionView | undefined {
  const { ink, menu } = input;
  if (menu.kind === "none") return undefined;

  const bodyHeight = panelBodyHeight(input.rows);
  if (bodyHeight === 0) return undefined;

  const sorted = menu.kind === "mention" ? sortSuggestions(menu.items) : menu.items;
  const count = sorted.length;
  const all =
    menu.kind === "slash"
      ? slashRows(input, menu.items)
      : mentionRows(input, sorted as readonly FileSuggestion[]);

  const window = listWindow({
    count,
    active: input.active,
    height: bodyHeight,
    previousTop: input.previousTop,
  });
  const body =
    count === 0
      ? [ink.fg("muted", "no matches")]
      : all.slice(window.top, window.top + window.height);

  const accept = menu.kind === "slash" ? "run" : "insert";
  const hints = [
    `${ink.glyphs.tab} complete`,
    `${ink.glyphs.enter} ${accept}`,
    "esc dismiss",
  ];

  return {
    frame: {
      ink,
      columns: input.columns,
      rows: input.rows,
      title: menu.kind === "slash" ? "/commands" : "@files",
      counter: windowCounter(input.active, count),
      hints,
      body,
    },
    top: window.top,
    count,
  };
}
