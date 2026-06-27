const SGR_MOUSE_RE = /\x1b?\[?<(?<button>\d+);\d+;\d+[mM]/g;
const PARTIAL_SGR_MOUSE_RE = /(?:\x1b?\[?<)?(?:6[45]|[0-9]{1,3});\d+;\d+[mM]/g;

export const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1000l";

/** Decode an SGR mouse-report chunk. -1 is wheel up, +1 is wheel down. */
export function mouseWheelDirection(data: string): -1 | 0 | 1 {
  for (const match of data.matchAll(SGR_MOUSE_RE)) {
    if (match.groups?.button === "64") return -1;
    if (match.groups?.button === "65") return 1;
  }
  for (const match of data.matchAll(PARTIAL_SGR_MOUSE_RE)) {
    const button = match[0].match(/(?:<)?(\d+);/)?.[1];
    if (button === "64") return -1;
    if (button === "65") return 1;
  }
  return 0;
}

/** True when a key chunk is a terminal mouse report, including split chunks. */
export function isMouseReport(data: string): boolean {
  SGR_MOUSE_RE.lastIndex = 0;
  PARTIAL_SGR_MOUSE_RE.lastIndex = 0;
  return SGR_MOUSE_RE.test(data) || PARTIAL_SGR_MOUSE_RE.test(data);
}

/** Remove mouse reports from a chunk before it reaches the composer. */
export function stripMouseReports(data: string): string {
  return data
    .replace(SGR_MOUSE_RE, "")
    .replace(PARTIAL_SGR_MOUSE_RE, "");
}
