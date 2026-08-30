import { wrapPagerLine } from "../../../ui-core/rendering/pager-chrome.js";
import { liveThinkingFull } from "../../../ui-core/rendering/thinking-tail.js";

export const THINKING_BODY_MAX_ROWS = 20;
const MAX_BODY_CHARS = 20_000;

export function wrapThinkingBody(
  content: string,
  width: number,
  streaming: boolean,
): string[] {
  if (streaming) return createLiveThinkingWrap(width)(content);
  const budget = Math.max(1, Math.floor(width));
  const source =
    content.length > MAX_BODY_CHARS
      ? `${content.slice(0, MAX_BODY_CHARS)}\n…`
      : content;
  if (!source.trim()) return [];
  const rows: string[] = [];
  for (const line of source.split("\n")) {
    for (const wrapped of wrapPagerLine(line, budget)) rows.push(wrapped);
  }
  return rows;
}

export function createLiveThinkingWrap(
  width: number,
): (content: string) => string[] {
  const budget = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let source = "";
  let tailLine = "";
  const view = (): string[] => {
    if (rows.length === 0 && !tailLine.trim()) return [];
    const tailRows = tailLine ? wrapPagerLine(tailLine, budget) : [];
    return [...rows, ...tailRows];
  };
  const wrapTail = (segment: string): void => {
    const combined = tailLine + segment;
    const lines = combined.split("\n");
    tailLine = lines.pop() ?? "";
    for (const line of lines) {
      for (const wrapped of wrapPagerLine(line, budget)) rows.push(wrapped);
    }
  };
  return (content: string): string[] => {
    const display = liveThinkingFull(content);
    if (display === source) return view();
    if (display.startsWith(source)) {
      wrapTail(display.slice(source.length));
    } else {
      rows.length = 0;
      tailLine = "";
      if (display.trim()) wrapTail(display);
    }
    source = display;
    return view();
  };
}

export interface ThinkingViewport {
  readonly rows: number;
  readonly offset: number;
  readonly maxOffset: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export function resolveThinkingViewport(input: {
  readonly lineCount: number;
  readonly offset: number;
  readonly maxRows?: number | undefined;
}): ThinkingViewport {
  const maxRows = Math.max(1, Math.floor(input.maxRows ?? THINKING_BODY_MAX_ROWS));
  const lineCount = Math.max(0, Math.floor(input.lineCount));
  const rows = Math.max(1, Math.min(maxRows, lineCount));
  const maxOffset = Math.max(0, lineCount - rows);
  const offset = Number.isFinite(input.offset)
    ? Math.max(0, Math.min(maxOffset, Math.floor(input.offset)))
    : maxOffset;
  return {
    rows,
    offset,
    maxOffset,
    hiddenAbove: offset,
    hiddenBelow: maxOffset - offset,
  };
}

export type ThinkingPresentation =
  | {
      readonly heading: string;
      readonly borderTitle: undefined;
      readonly layout: "line";
      readonly showBody: false;
    }
  | {
      readonly heading: string;
      readonly borderTitle: string;
      readonly layout: "card";
      readonly showBody: true;
    };

export function thinkingTokenEstimate(content: string): number {
  return content.length === 0 ? 0 : Math.max(1, Math.round(content.length / 4));
}

function tokenLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "token" : "tokens"}`;
}

export function resolveThinkingPresentation(input: {
  readonly streaming: boolean;
  readonly expanded: boolean;
  readonly elapsed?: string | undefined;
  readonly content: string;
}): ThinkingPresentation {
  const tokens = tokenLabel(thinkingTokenEstimate(input.content));
  if (input.streaming) {
    const heading = `✦ ${["Reasoning", input.elapsed, tokens].filter(Boolean).join(" · ")}`;
    return {
      heading,
      borderTitle: ` ${heading} `,
      layout: "card",
      showBody: true,
    };
  }

  const thought = input.elapsed ? `Thought for ${input.elapsed}` : "Thought";
  if (!input.expanded) {
    return {
      heading: `✦ ${thought} · ${tokens} · click or Ctrl+T to view`,
      borderTitle: undefined,
      layout: "line",
      showBody: false,
    };
  }

  const heading = `✦ ${thought} · ${tokens}`;
  return {
    heading,
    borderTitle: ` ${heading} `,
    layout: "card",
    showBody: true,
  };
}

export interface ThinkingHeadingStyle {
  readonly fg: string;
  readonly underline: boolean;
}

export function resolveThinkingFooter(input: {
  readonly focused: boolean;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}): string | undefined {
  if (!input.focused) return " click to focus ";
  const scrollable = input.hiddenAbove + input.hiddenBelow > 0;
  if (!scrollable) return " c to copy ";
  return ` ↑ ${input.hiddenAbove} · ↓ ${input.hiddenBelow} · c to copy `;
}

export function resolveThinkingHeadingStyle(input: {
  readonly hovered: boolean;
  readonly accent: string;
  readonly hover: string;
}): ThinkingHeadingStyle {
  return input.hovered
    ? { fg: input.hover, underline: true }
    : { fg: input.accent, underline: false };
}
