/** @jsxImportSource @opentui/react */

import { homedir } from "node:os";
import type { ReactNode } from "react";
import { detectLinks, type LinkSpan } from "../../../ui-core/rendering/link-detector.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { SELECTABLE_LINE_STYLE } from "./selectable-line.js";

function resolveHref(span: LinkSpan): string | undefined {
  if (span.kind === "url") return span.value;
  const pathOnly = span.value.split(":")[0] ?? span.value;
  if (pathOnly.startsWith("/")) return `file://${pathOnly}`;
  if (pathOnly.startsWith("~/")) return `file://${homedir()}${pathOnly.slice(1)}`;
  return undefined;
}

export function LinkableText(props: {
  text: string;
  theme: Theme;
  fg?: string;
  selectable?: boolean;
  wrapMode?: "none" | "char" | "word" | undefined;
}): ReactNode {
  const { text, theme, fg, selectable = true, wrapMode } = props;
  const spans = detectLinks(text);
  const style = {
    fg: fg ?? theme.foreground,
    ...(selectable ? SELECTABLE_LINE_STYLE : {}),
  };
  if (spans.length === 0) {
    return (
      <text
        content={text.length === 0 ? " " : text}
        selectable={selectable}
        {...(wrapMode ? { wrapMode } : {})}
        style={style}
      />
    );
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) nodes.push(text.slice(cursor, span.start));
    const href = resolveHref(span);
    const key = `${span.start}-${span.end}`;
    nodes.push(
      href ? (
        <a key={key} href={href} style={{ fg: theme.accent }}>
          {span.value}
        </a>
      ) : (
        <span key={key} style={{ fg: theme.accent }}>
          {span.value}
        </span>
      ),
    );
    cursor = span.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));

  return (
    <text
      selectable={selectable}
      {...(wrapMode ? { wrapMode } : {})}
      style={style}
    >
      {nodes}
    </text>
  );
}
