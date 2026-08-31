import { Chalk, type ChalkInstance } from "chalk";
import chalk from "chalk";
import type { ColorMode } from "../../app/ports/terminal-port.js";
import type { ThemeHint } from "../../ui-core/bootstrap/capabilities.js";
import type { Theme } from "../../ui-core/rendering/theme.js";
import { themeFor } from "../../ui-core/rendering/theme.js";
import { type Glyphs, glyphsFor } from "./glyphs.js";
import { sealStyle } from "./ansi-text.js";

export type ThemeToken = {
  [K in keyof Theme]: Theme[K] extends string ? K : never;
}[keyof Theme];

const CHALK_LEVEL: Record<ColorMode, 0 | 1 | 2 | 3> = {
  none: 0,
  "16": 1,
  "256": 2,
  truecolor: 3,
};

export interface TextStyle {
  readonly fg?: ThemeToken | undefined;
  readonly bg?: ThemeToken | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly inverse?: boolean | undefined;
  readonly underline?: boolean | undefined;
}

export interface InkTheme {
  readonly theme: Theme;
  readonly colorMode: ColorMode;
  readonly unicode: boolean;
  readonly italicOk: boolean;
  readonly glyphs: Glyphs;
  inkColor(token: ThemeToken): string | undefined;
  style(text: string, style: TextStyle): string;
  fg(token: ThemeToken, text: string): string;
  hex(color: string, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  inverse(text: string): string;
  plate(token: ThemeToken, text: string): string;
}

export interface InkThemeInput {
  readonly themeHint: ThemeHint;
  readonly colorMode: ColorMode;
  readonly unicode: boolean;
  readonly italic?: boolean | undefined;
}

export function createInkTheme(input: InkThemeInput): InkTheme {
  const theme = themeFor(input.themeHint);
  const level = CHALK_LEVEL[input.colorMode];
  const paint: ChalkInstance = new Chalk({ level });
  const colored = level > 0;
  const italicOk = input.italic ?? input.unicode;

  const style = (text: string, spec: TextStyle): string => {
    if (text.length === 0) return text;
    let chain = paint;
    if (colored && spec.bg) chain = chain.bgHex(theme[spec.bg]);
    if (colored && spec.fg) chain = chain.hex(theme[spec.fg]);
    if (spec.bold) chain = chain.bold;
    if (spec.dim) chain = chain.dim;
    if (spec.italic && italicOk) chain = chain.italic;
    if (spec.underline) chain = chain.underline;
    if (spec.inverse) chain = chain.inverse;
    return sealStyle(chain(text));
  };

  return {
    theme,
    colorMode: input.colorMode,
    unicode: input.unicode,
    italicOk,
    glyphs: glyphsFor(input.unicode),
    inkColor: (token) => (colored ? theme[token] : undefined),
    style,
    fg: (token, text) => style(text, { fg: token }),
    hex: (color, text) =>
      text.length === 0 || !colored ? text : sealStyle(paint.hex(color)(text)),
    bold: (text) => style(text, { bold: true }),
    dim: (text) => style(text, { dim: true }),
    inverse: (text) => style(text, { inverse: true }),
    plate: (token, text) => style(text, { bg: token, fg: "white", bold: true }),
  };
}


export function withColorMode<T>(mode: ColorMode, render: () => T): T {
  const level = CHALK_LEVEL[mode];
  const previous = chalk.level;
  if (previous === level) return render();
  chalk.level = level;
  try {
    return render();
  } finally {
    chalk.level = previous;
  }
}
