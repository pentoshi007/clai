import { createElement, useMemo, type ReactNode } from "react";
import { RGBA, StyledText } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { styleAnsiLine, type StyledLine } from "../../rendering/styled-markdown.js";
import { StyledTextBlock } from "./styled-text-block.js";

export function ToolOutputBranch(props: {
  readonly lines: readonly string[];
  readonly formatted: readonly StyledLine[] | null;
  readonly theme: Theme;
}): ReactNode {
  const { lines, formatted, theme } = props;
  const rows = useMemo(() => {
    const source = formatted ?? lines.map((line) => styleAnsiLine(
      line,
      line.startsWith("…") || line.startsWith("···") ? theme.muted : theme.toolOutput,
    ));
    if (source.length === 0) return [];
    const fg = RGBA.fromHex(theme.toolOutput);
    return [
      new StyledText([{ __isChunk: true, text: "│", fg }]),
      ...source.map((line, index) => new StyledText([
        { __isChunk: true, text: index === 0 ? "└─ " : "   ", fg },
        ...line.chunks,
      ])),
    ];
  }, [lines, formatted, theme]);
  return createElement(StyledTextBlock, { lines: rows, background: theme.statusBackground });
}
