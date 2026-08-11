/** @jsxImportSource @opentui/react */
/**
 * Renders plain text with detected URLs/paths as real hyperlinks (P1
 * "clickable links/file paths"; V2-055). `<a href>` emits the terminal's
 * native OSC 8 hyperlink, so the host terminal's own click/modifier
 * convention applies — there is no custom open-URL port to build here.
 *
 * Only absolute (`/...`) and home-relative (`~/...`) paths resolve to a
 * `file://` href; a bare relative path (`./foo.ts`) has no reliable base
 * directory at this layer, so it gets the accent color without a href rather
 * than risking a link to the wrong file.
 */

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
  /** Default true; set false on clickable chrome (YOU bubble). */
  selectable?: boolean;
  /**
   * OpenTUI wrap. Use `"none"` when the caller already soft-wrapped to a
   * column budget (user prompts beside the tasks pane).
   */
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
