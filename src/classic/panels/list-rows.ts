import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";

export const DESCRIPTION_MIN_COLUMNS = 68;

export interface ListRowInput {
  readonly ink: InkTheme;
  readonly width: number;
  readonly columns: number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly active: boolean;
  readonly labelToken?: ThemeToken | undefined;
  readonly descriptionToken?: ThemeToken | undefined;
  readonly trailing?: string | undefined;
  readonly marker?: string | undefined;
}

export function showsDescription(columns: number): boolean {
  return columns >= DESCRIPTION_MIN_COLUMNS;
}

export function listRow(input: ListRowInput): string {
  const { ink } = input;
  const markerText = input.marker ?? (input.active ? `${ink.glyphs.promptMark} ` : "  ");
  const marker = ink.style(markerText, { fg: "inputBorder" });
  const inner = Math.max(1, input.width - layoutWidth(markerText));

  const right =
    input.description && showsDescription(input.columns) ? input.description : "";
  const trailing = input.trailing ?? "";
  const tailText = [right, trailing].filter((part) => part !== "").join("  ");
  const tailWidth = tailText === "" ? 0 : layoutWidth(tailText) + 1;
  const labelWidth = Math.max(1, inner - tailWidth);

  const label = padToWidth(
    clipToWidth(input.label, labelWidth, ink.glyphs.ellipsis),
    labelWidth,
  );
  const painted = ink.style(label, {
    fg: input.active ? "accent" : (input.labelToken ?? "foreground"),
    bold: input.active,
  });
  const tail =
    tailText === ""
      ? ""
      : ink.style(padToWidth(` ${tailText}`, tailWidth), {
          fg: input.descriptionToken ?? "muted",
        });

  return sealStyle(`${marker}${painted}${tail}`);
}

export interface ListSubRowInput {
  readonly ink: InkTheme;
  readonly width: number;
  readonly text: string;
  readonly active: boolean;
  readonly token?: ThemeToken | undefined;
  readonly indent?: number | undefined;
}

export function listSubRow(input: ListSubRowInput): string {
  const { ink } = input;
  const indent = " ".repeat(Math.max(0, input.indent ?? 4));
  const body = padToWidth(
    clipToWidth(`${indent}${input.text}`, input.width, ink.glyphs.ellipsis),
    input.width,
  );
  return sealStyle(ink.style(body, { fg: input.token ?? "muted", bold: input.active }));
}

export function filterRow(ink: InkTheme, width: number, label: string, query: string): string {
  const text = padToWidth(
    clipToWidth(`${label}: ${query}`, width, ink.glyphs.ellipsis),
    width,
  );
  return sealStyle(ink.fg("accent", text));
}

export function emptyRow(ink: InkTheme, width: number, text = "no matches"): string {
  return sealStyle(ink.fg("muted", clipToWidth(text, width, ink.glyphs.ellipsis)));
}
