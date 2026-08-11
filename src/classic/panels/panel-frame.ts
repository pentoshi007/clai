import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";

export interface PanelFrameInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly title: string;
  readonly counter?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly hints?: readonly string[] | undefined;
  readonly borderColor?: ThemeToken | undefined;
  readonly body: readonly string[];
}

export interface PanelFrameRows {
  readonly rows: readonly string[];
  readonly bodyHeight: number;
  readonly bodyWidth: number;
}

export function panelBodyHeight(rows: number): number {
  return Math.max(0, rows - 2);
}

export function panelBodyWidth(columns: number): number {
  return Math.max(1, Math.floor(columns) - 4);
}

export function panelFrameRows(input: PanelFrameInput): PanelFrameRows {
  const ink = input.ink;
  const glyphs = ink.glyphs;
  const token: ThemeToken = input.borderColor ?? "inputBorder";
  const width = Math.max(1, Math.floor(input.columns));
  const bodyWidth = Math.max(1, width - 4);
  const bodyHeight = panelBodyHeight(input.rows);
  const paint = (text: string): string => ink.fg(token, text);

  const head = input.title === "" ? "" : ` ${input.title} `;
  const tailParts = [
    ...(input.tags ?? []).map((tag) => `${tag} `),
    ...(input.counter === undefined ? [] : [`${input.counter} `]),
  ];
  const tail = tailParts.join("");
  const fillWidth = Math.max(
    1,
    width - 2 - layoutWidth(head) - layoutWidth(tail),
  );
  const top = paint(
    `${glyphs.boxTopLeft}${clipToWidth(head, Math.max(0, width - 3), glyphs.ellipsis)}${glyphs.rule.repeat(fillWidth)}${tail}${glyphs.boxTopRight}`,
  );

  const hintText = (input.hints ?? []).join(` ${glyphs.separator} `);
  const hintBudget = Math.max(0, width - 5);
  const hintBody =
    hintText === "" || width < 4
      ? ""
      : ` ${clipToWidth(hintText, hintBudget, glyphs.ellipsis)} `;
  const bottomFill = Math.max(0, width - 2 - layoutWidth(hintBody));
  const bottom = `${paint(glyphs.boxBottomLeft)}${ink.fg("muted", hintBody)}${paint(`${glyphs.rule.repeat(bottomFill)}${glyphs.boxBottomRight}`)}`;

  const side = paint(glyphs.boxVertical);
  const body: string[] = [];
  for (let index = 0; index < bodyHeight; index += 1) {
    const content = input.body[index] ?? "";
    // Body rows are pre-wrapped by each panel view. Do not truncate a user
    // value at the frame boundary; clipping here would silently discard it.
    const cell = padToWidth(content, bodyWidth);
    body.push(sealStyle(`${side} ${cell} ${side}`));
  }

  return {
    rows: bodyHeight === 0 ? [] : [top, ...body, bottom],
    bodyHeight,
    bodyWidth: Math.max(1, bodyWidth),
  };
}
