import { createElement, useMemo, type ReactNode } from "react";
import { joinStyledLines, type StyledLine } from "../../rendering/styled-markdown.js";

export function StyledTextBlock(props: {
  readonly lines: readonly StyledLine[];
  readonly background: string;
}): ReactNode {
  const content = useMemo(() => joinStyledLines(props.lines), [props.lines]);
  if (props.lines.length === 0) return null;
  return createElement("text", {
    content,
    selectable: true,
    wrapMode: "none",
    style: { width: "100%", height: props.lines.length, flexShrink: 0, bg: props.background },
  });
}
