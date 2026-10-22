export const THINKING_BODY_MAX_ROWS = 20;

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
  return { fg: input.hovered ? input.hover : input.accent };
}
