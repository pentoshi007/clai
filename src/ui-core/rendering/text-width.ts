/**
 * Column budgeting for text a terminal may shape wider than we measure.
 *
 * `string-width` implements wcwidth: a Devanagari matra counts 0, a ZWJ counts
 * 0, CJK counts 2. OpenTUI's own buffer agrees with that model — verified
 * headlessly, its cells hold whole grapheme clusters and an end-of-row marker
 * survives on Devanagari, CJK, combining-Latin and ZWJ-emoji rows.
 *
 * Real terminals do not always agree. Their font shapers give Devanagari
 * clusters more columns than wcwidth claims, which pushes the tail of such a
 * line into columns the renderer believes are blank. Those cells are outside
 * every row's box, so damage tracking never rewrites them and the tail glyphs
 * pile up down the column as the viewport scrolls (a Hindi poster label seeding
 * a stray `अ`/`ब`/`'` at the pane edge).
 *
 * Reserving the larger of wcwidth and the UTF-16 unit count makes those lines
 * wrap earlier, so the tail never reaches the disputed columns. Confirmed
 * against a real terminal: with this measure the leaked glyph set shrank; with
 * plain `string-width` it grew back. Identical for ASCII, and CJK still gets its
 * double-width treatment.
 *
 * Cost: a complex-script line can wrap a column or two early, and a bordered
 * panel's right edge can sit slightly inside on such rows. Both are cosmetic;
 * the leak is not.
 */

import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;

/** Columns to reserve for `text` — never fewer than a terminal may use. */
export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(stringWidth(plain), plain.length);
}
