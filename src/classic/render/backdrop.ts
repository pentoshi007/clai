import { padToWidth, trimTrailingSpaces } from "./ansi-text.js";
import type { InkTheme, ThemeToken } from "./ink-theme.js";

const FULL_RESET = "\x1b[0m";

/**
 * Fill a whole row with a background colour, edge to edge.
 *
 * Wrapped builders seal every styled segment with `\x1b[0m`, which would end
 * the fill at the first inner span; each bare reset is therefore followed by
 * the background's own open sequence so the slab survives every nested span.
 * With colour disabled the row is returned unstyled.
 */
export function backdropRow(
  ink: InkTheme,
  token: ThemeToken,
  line: string,
  width: number,
): string {
  const probe = ink.style(" ", { bg: token });
  const spaceAt = probe.indexOf(" ");
  const open = probe.slice(0, spaceAt);
  const close = probe.slice(spaceAt + 1);
  const padded = padToWidth(trimTrailingSpaces(line), Math.max(1, Math.floor(width)));
  if (open === "") return padded;
  return `${open}${padded.split(FULL_RESET).join(FULL_RESET + open)}${close}`;
}
