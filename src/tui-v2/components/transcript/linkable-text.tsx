/** @jsxImportSource @opentui/react */

import { homedir } from "node:os";
import type { ReactNode } from "react";
import { detectLinks, type LinkSpan } from "../../../ui-core/rendering/link-detector.js";
import { middleClipText } from "../../../ui-core/rendering/text-width.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { SELECTABLE_LINE_STYLE } from "./selectable-line.js";

function resolveHref(span: LinkSpan): string | undefined {
  if (span.kind === "url") return span.value;
  const pathOnly = span.value.split(":")[0] ?? span.value;
  if (pathOnly.startsWith("/")) return `file://${pathOnly}`;
  if (pathOnly.startsWith("~/")) return `file://${homedir()}${pathOnly.slice(1)}`;
  return undefined;
}

/**
 * A clipped path stops matching the link regex, so the href has to come from
 * the unclipped text. Only whole-text links are clipped; mixed prose keeps its
 * spans and wraps as before.
 */
function clippedWholeLink(
  text: string,
  columns: number,
): { readonly display: string; readonly span: LinkSpan } | undefined {
  const spans = detectLinks(text);
  const span = spans.length === 1 ? spans[0] : undefined;
  if (!span || span.start !== 0 || span.end !== text.length) return undefined;
  const display = middleClipText(text, columns);
  return display === text ? undefined : { display, span };
}

export function LinkableText(props: {
  text: string;
  theme: Theme;
  fg?: string;
  selectable?: boolean;
  wrapMode?: "none" | "char" | "word" | undefined;
  /** Middle-clip a whole-text link to this many columns so it stays on one row. */
  clipTo?: number | undefined;
}): ReactNode {
  const { text, theme, fg, selectable = true, wrapMode, clipTo } = props;
  const style = {
    fg: fg ?? theme.foreground,
    ...(selectable ? SELECTABLE_LINE_STYLE : {}),
  };

  const clipped = clipTo === undefined ? undefined : clippedWholeLink(text, clipTo);
  if (clipped) {
    const href = resolveHref(clipped.span);
    const content = clipped.display.length === 0 ? " " : clipped.display;
    return (
      <text selectable={selectable} wrapMode="none" style={style}>
        {href ? (
          <a href={href} style={{ fg: theme.accent }}>
            {content}
          </a>
        ) : (
          <span style={{ fg: theme.accent }}>{content}</span>
        )}
      </text>
    );
  }

  const spans = detectLinks(text);
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
