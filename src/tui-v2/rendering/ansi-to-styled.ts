/**
 * Convert chalk/SGR ANSI strings into OpenTUI `StyledText` so legacy-colored
 * output (intro card, badges) can render with real fg/bg in OpenTUI.
 */

import { RGBA, StyledText, TextAttributes } from "@opentui/core";
import type { TextChunk } from "@opentui/core";

const BOLD = TextAttributes.BOLD;
const DIM = TextAttributes.DIM;

/** Basic 16-color ANSI → RGB (approximate xterm defaults). */
const BASIC_FG: Record<number, [number, number, number]> = {
  30: [0, 0, 0],
  31: [205, 49, 49],
  32: [13, 188, 121],
  33: [229, 229, 16],
  34: [36, 114, 200],
  35: [188, 63, 188],
  36: [17, 168, 205],
  37: [229, 229, 229],
  90: [102, 102, 102],
  91: [241, 76, 76],
  92: [35, 209, 139],
  93: [245, 245, 67],
  94: [59, 142, 234],
  95: [214, 112, 214],
  96: [41, 184, 219],
  97: [255, 255, 255],
};

const BASIC_BG: Record<number, [number, number, number]> = {
  40: [0, 0, 0],
  41: [205, 49, 49],
  42: [13, 188, 121],
  43: [229, 229, 16],
  44: [36, 114, 200],
  45: [188, 63, 188],
  46: [17, 168, 205],
  47: [229, 229, 229],
  100: [102, 102, 102],
  101: [241, 76, 76],
  102: [35, 209, 139],
  103: [245, 245, 67],
  104: [59, 142, 234],
  105: [214, 112, 214],
  106: [41, 184, 219],
  107: [255, 255, 255],
};

function rgb(r: number, g: number, b: number): RGBA {
  return RGBA.fromInts(r, g, b, 255);
}

export interface AnsiToStyledOptions {
  /**
   * Applied to text that has no explicit SGR foreground (so assistant
   * bodies can default to green while chalk bold/cyan/code still wins).
   */
  readonly defaultFg?: string | RGBA | undefined;
}

function resolveColor(input: string | RGBA | undefined): RGBA | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") {
    try {
      return RGBA.fromHex(input);
    } catch {
      return undefined;
    }
  }
  return input;
}

/**
 * Parse a string that may contain CSI SGR sequences into StyledText.
 * Unsupported sequences are ignored; plain text is preserved.
 */
export function ansiToStyledText(
  input: string,
  options: AnsiToStyledOptions = {},
): StyledText {
  if (!input) {
    return new StyledText([{ __isChunk: true, text: " " }]);
  }

  const defaultFg = resolveColor(options.defaultFg);
  const chunks: TextChunk[] = [];
  let fg: RGBA | undefined;
  let bg: RGBA | undefined;
  let attributes = 0;
  let buf = "";

  const flush = (): void => {
    if (buf.length === 0) return;
    const chunk: TextChunk = { __isChunk: true, text: buf };
    const useFg = fg ?? defaultFg;
    if (useFg) chunk.fg = useFg;
    if (bg) chunk.bg = bg;
    if (attributes) chunk.attributes = attributes;
    chunks.push(chunk);
    buf = "";
  };

  let i = 0;
  while (i < input.length) {
    if (input.charCodeAt(i) === 0x1b && input[i + 1] === "[") {
      const end = input.indexOf("m", i + 2);
      if (end === -1) {
        buf += input[i];
        i++;
        continue;
      }
      flush();
      const body = input.slice(i + 2, end);
      i = end + 1;
      const parts = body.length === 0 ? [0] : body.split(";").map((p) => Number(p));
      applySgr(parts, {
        setFg: (c) => {
          fg = c;
        },
        setBg: (c) => {
          bg = c;
        },
        clearFg: () => {
          fg = undefined;
        },
        clearBg: () => {
          bg = undefined;
        },
        setBold: (on) => {
          attributes = on ? attributes | BOLD : attributes & ~BOLD;
        },
        setDim: (on) => {
          attributes = on ? attributes | DIM : attributes & ~DIM;
        },
        reset: () => {
          fg = undefined;
          bg = undefined;
          attributes = 0;
        },
      });
      continue;
    }
    buf += input[i];
    i++;
  }
  flush();

  if (chunks.length === 0) {
    return new StyledText([{ __isChunk: true, text: " " }]);
  }
  return new StyledText(chunks);
}

interface SgrSink {
  setFg(c: RGBA): void;
  setBg(c: RGBA): void;
  clearFg(): void;
  clearBg(): void;
  setBold(on: boolean): void;
  setDim(on: boolean): void;
  reset(): void;
}

function applySgr(parts: number[], sink: SgrSink): void {
  let i = 0;
  while (i < parts.length) {
    const code = parts[i] ?? 0;
    if (code === 0) {
      sink.reset();
      i++;
      continue;
    }
    if (code === 1) {
      sink.setBold(true);
      i++;
      continue;
    }
    if (code === 2) {
      sink.setDim(true);
      i++;
      continue;
    }
    if (code === 22) {
      sink.setBold(false);
      sink.setDim(false);
      i++;
      continue;
    }
    if (code === 39) {
      sink.clearFg();
      i++;
      continue;
    }
    if (code === 49) {
      sink.clearBg();
      i++;
      continue;
    }
    // 38;2;r;g;b or 38;5;n
    if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = parts[i + 1];
      if (mode === 2 && i + 4 < parts.length) {
        const r = parts[i + 2] ?? 0;
        const g = parts[i + 3] ?? 0;
        const b = parts[i + 4] ?? 0;
        const color = rgb(r, g, b);
        if (isFg) sink.setFg(color);
        else sink.setBg(color);
        i += 5;
        continue;
      }
      if (mode === 5 && i + 2 < parts.length) {
        const idx = parts[i + 2] ?? 0;
        const color = RGBA.fromIndex(idx);
        if (isFg) sink.setFg(color);
        else sink.setBg(color);
        i += 3;
        continue;
      }
      i++;
      continue;
    }
    if (BASIC_FG[code]) {
      const [r, g, b] = BASIC_FG[code]!;
      sink.setFg(rgb(r, g, b));
      i++;
      continue;
    }
    if (BASIC_BG[code]) {
      const [r, g, b] = BASIC_BG[code]!;
      sink.setBg(rgb(r, g, b));
      i++;
      continue;
    }
    i++;
  }
}
