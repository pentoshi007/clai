export interface Glyphs {
  readonly promptMark: string;
  readonly userRail: string;
  readonly assistantBullet: string;
  readonly thinkingGutter: string;
  readonly toolQueued: string;
  readonly toolRunning: string;
  readonly toolOk: string;
  readonly toolFailed: string;
  readonly toolBlocked: string;
  readonly bodyBranch: string;
  readonly ellipsis: string;
  readonly rule: string;
  readonly boxTopLeft: string;
  readonly boxTopRight: string;
  readonly boxBottomLeft: string;
  readonly boxBottomRight: string;
  readonly boxVertical: string;
  readonly taskPending: string;
  readonly taskActive: string;
  readonly taskDone: string;
  readonly taskFailed: string;
  readonly taskSkipped: string;
  readonly progressFilled: string;
  readonly progressEmpty: string;
  readonly warning: string;
  readonly scrollUp: string;
  readonly scrollDown: string;
  readonly separator: string;
  readonly compacted: string;
  readonly caret: string;
  readonly clip: string;
  readonly tab: string;
  readonly enter: string;
  readonly sticky: string;
  readonly stickyOff: string;
  readonly remove: string;
  readonly lock: string;
  readonly spinner: readonly string[];
}

export const UNICODE_GLYPHS: Glyphs = Object.freeze({
  promptMark: "❯",
  userRail: "▌",
  assistantBullet: "◆",
  thinkingGutter: "│",
  toolQueued: "○",
  toolRunning: "●",
  toolOk: "✓",
  toolFailed: "✗",
  toolBlocked: "⊘",
  bodyBranch: "└",
  ellipsis: "…",
  rule: "─",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  boxVertical: "│",
  taskPending: "○",
  taskActive: "◉",
  taskDone: "✓",
  taskFailed: "✗",
  taskSkipped: "–",
  progressFilled: "█",
  progressEmpty: "░",
  warning: "⚠",
  scrollUp: "▲",
  scrollDown: "▼",
  separator: "·",
  compacted: "✦",
  caret: "▎",
  clip: "↕",
  tab: "⇥",
  enter: "⏎",
  sticky: "★",
  stickyOff: "☆",
  remove: "×",
  lock: "🔒",
  spinner: Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
});

export const ASCII_GLYPHS: Glyphs = Object.freeze({
  promptMark: ">",
  userRail: "|",
  assistantBullet: "*",
  thinkingGutter: ":",
  toolQueued: "o",
  toolRunning: "*",
  toolOk: "v",
  toolFailed: "x",
  toolBlocked: "#",
  bodyBranch: "\\",
  ellipsis: "...",
  rule: "-",
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxVertical: "|",
  taskPending: "o",
  taskActive: "*",
  taskDone: "v",
  taskFailed: "x",
  taskSkipped: "-",
  progressFilled: "#",
  progressEmpty: ".",
  warning: "!",
  scrollUp: "^",
  scrollDown: "v",
  separator: "-",
  compacted: "*",
  caret: ">",
  clip: "^",
  tab: "tab",
  enter: "enter",
  sticky: "*",
  stickyOff: "-",
  remove: "x",
  lock: "#",
  spinner: Object.freeze(["-", "\\", "|", "/"]),
});

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

const PRESENTER_ONLY_ASCII: readonly (readonly [string, string])[] = [
  ["◌", "o"],
  ["⟳", "*"],
  ["◐", "*"],
  ["■", "#"],
  ["▪", "-"],
];

const UNICODE_TO_ASCII: ReadonlyMap<string, string> = new Map([
  ...(Object.keys(UNICODE_GLYPHS) as (keyof Glyphs)[])
    .filter((key) => key !== "spinner")
    .map((key) => [UNICODE_GLYPHS[key] as string, ASCII_GLYPHS[key] as string] as const),
  ...PRESENTER_ONLY_ASCII,
]);

export function toAsciiGlyphs(text: string): string {
  let out = "";
  for (const char of text) {
    out += UNICODE_TO_ASCII.get(char) ?? char;
  }
  return out;
}

export function adaptPresenterGlyphs(text: string, unicode: boolean): string {
  return unicode ? text : toAsciiGlyphs(text);
}
