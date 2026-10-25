/** @jsxImportSource @opentui/react */

import { memo, type ReactNode } from "react";
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  overlayPagerSegments,
  segmentPagerLine,
  type PagerLineSegment,
  type PagerMatch,
} from "../../../ui-core/state/pager-search.js";
import { parseModalDiffLine, syntaxColor } from "../../../ui-core/rendering/file-diff-view.js";
import {
  highlightLineForPath,
  type SyntaxSpan,
} from "../../../ui-core/rendering/syntax-highlight.js";
import type { PagerDisplayLine } from "../../rendering/pager-markdown.js";
import type { SubagentSpan } from "../../../ui-core/rendering/subagent-presentation.js";
import { pagerCommandColor, type PagerCommandTone } from "../../../ui-core/rendering/pager-regions.js";

export function baseLineFg(line: string, theme: Theme): string {
  const t = line.trim();
  if (/^──\s*full output saved at/i.test(t)) return theme.response;
  if (/^\/Users\/|^\/home\/|^~\/|^\.clai\/|outputs\//i.test(t)) {
    return theme.response;
  }
  if (t.startsWith("─")) return theme.chip;
  if (/^(Approach|Tasks|Goal|Status)\b/i.test(t) && !t.includes("  ·")) {
    return theme.cyan;
  }
  if (/^Status\s+/i.test(t) || /^Updated\s+/i.test(t)) return theme.muted;
  if (/^[✓✗○◉–]\s/.test(t) || /^\s+[✓✗○◉–]\s/.test(line)) {
    if (t.startsWith("✓") || line.includes("  ✓")) return theme.success;
    if (t.startsWith("✗") || line.includes("  ✗")) return theme.accent;
    if (t.startsWith("◉") || line.includes("  ◉")) return theme.activity;
    return theme.muted;
  }
  if (/^(Next:|Plan is approved|All tasks completed)/i.test(t)) return theme.muted;
  if (/q\/esc:close|Esc or q to close/i.test(t)) return theme.muted;
  return theme.foreground;
}

export const parseDiffLine = parseModalDiffLine;

function matchStyle(kind: PagerLineSegment["kind"], theme: Theme): { fg: string; bg: string; attributes: number } | undefined {
  if (kind === "active") return { fg: theme.background, bg: theme.activity, attributes: TextAttributes.BOLD };
  if (kind === "match") return { fg: theme.white, bg: theme.selection, attributes: TextAttributes.BOLD };
  return undefined;
}

function syntaxMatchSpans(spans: readonly SyntaxSpan[], segments: readonly PagerLineSegment[], theme: Theme): ReactNode[] {
  return overlayPagerSegments(spans, segments).map((piece, i) => (
    <span key={i} style={matchStyle(piece.kind, theme) ?? { fg: syntaxColor(piece.source.kind, theme) }}>
      {piece.text}
    </span>
  ));
}

function styledWithMatches(styled: StyledText, segments: readonly PagerLineSegment[], theme: Theme): StyledText {
  return new StyledText(overlayPagerSegments(styled.chunks, segments).map((piece): TextChunk => {
    const style = matchStyle(piece.kind, theme);
    const { fg, bg, attributes } = piece.source;
    if (!style) return { __isChunk: true, text: piece.text, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}), ...(attributes ? { attributes } : {}) };
    return { __isChunk: true, text: piece.text, fg: RGBA.fromHex(style.fg), bg: RGBA.fromHex(style.bg), attributes: style.attributes };
  }));
}

export function bodyOnlyForCopy(full: string): string {
  return full
    .split("\n")
    .map((line) => {
      const p = parseDiffLine(line);
      if (p) return p.code;
      return line;
    })
    .join("\n");
}

export const PagerLine = memo(PagerLineImpl);

function PagerLineImpl(props: {
  line: string;
  index: number;
  theme: Theme;
  matches: readonly PagerMatch[];
  activeMatchIndex: number;
  hasQuery: boolean;
  highlightPath: string;
  spans?: readonly SyntaxSpan[] | undefined;
  styled?: PagerDisplayLine["styled"];
  markdownMode?: boolean | undefined;
  diffGutters?: boolean | undefined;
  subagent?: boolean | undefined;
  subagentSpans?: readonly SubagentSpan[] | undefined;
  tone?: PagerCommandTone | undefined;
}): ReactNode {
  const {
    line,
    index,
    theme,
    matches,
    activeMatchIndex,
    hasQuery,
    highlightPath,
    spans: precomputedSpans,
    styled,
    markdownMode,
  } = props;
  const isActiveLine =
    hasQuery &&
    activeMatchIndex >= 0 &&
    matches[activeMatchIndex]?.line === index;

  const subagentSpans = hasQuery ? undefined : props.subagentSpans;
  if (subagentSpans) {
    return (
      <text
        id={`pager-line-${index}`}
        selectable
        wrapMode="word"
        style={{ width: "100%", bg: theme.background }}
      >
        {subagentSpans.map((span, i) => (
          <span key={i} style={{ fg: theme[span.fg], attributes: span.bold ? TextAttributes.BOLD : 0 }}>
            {span.text}
          </span>
        ))}
      </text>
    );
  }

  if (markdownMode) {
    const body = line.length > 0 ? line : " ";
    const lineHasMatch = hasQuery && matches.some((m) => m.line === index);
    if (styled && lineHasMatch) {
      return (
        <text
          id={`pager-line-${index}`}
          content={styledWithMatches(styled, segmentPagerLine(body, index, matches, activeMatchIndex), theme)}
          selectable
          wrapMode="word"
          style={{ width: "100%", bg: theme.background }}
        />
      );
    }
    if (styled) {
      return (
        <text
          id={`pager-line-${index}`}
          content={styled}
          selectable
          wrapMode="word"
          style={{ width: "100%", bg: theme.background }}
        />
      );
    }
    const isMatchLine =
      hasQuery &&
      matches.length > 0 &&
      matches.some((m) => m.line === index);
    return (
      <text
        id={`pager-line-${index}`}
        content={body}
        selectable
        wrapMode="word"
        style={{
          width: "100%",
          fg: isActiveLine ? theme.background : theme.foreground,
          ...(isActiveLine
            ? {
                bg: theme.activity,
                attributes: TextAttributes.BOLD,
              }
            : isMatchLine
              ? { bg: theme.selection }
              : { bg: theme.background }),
        }}
      />
    );
  }

  const parsed = props.diffGutters === false ? null : parseDiffLine(line);

  if (parsed) {
    const bg =
      parsed.tone === "add"
        ? theme.diffAddBg
        : parsed.tone === "del"
          ? theme.diffDelBg
          : isActiveLine
            ? theme.rowA
            : undefined;
    const spans =
      parsed.tone === "header"
        ? [{ kind: "plain" as const, text: parsed.code }]
        : precomputedSpans ?? highlightLineForPath(parsed.code, highlightPath);
    const bodyForSearch = parsed.code;
    const segs =
      hasQuery && matches.length > 0
        ? segmentPagerLine(bodyForSearch, index, matches, activeMatchIndex)
        : null;

    const codeBg =
      parsed.tone === "add" || parsed.tone === "del"
        ? bg
        : isActiveLine
          ? theme.rowA
          : undefined;

    return (
      <box
        id={`pager-line-${index}`}
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: bg ?? theme.background,
        }}
      >
        <text selectable={false} style={{ height: 1, flexShrink: 0 }}>
          <span style={{ fg: theme.diffGutter }}>{parsed.gutter}</span>
          <span style={{ fg: theme.diffGutter }}>{" │ "}</span>
        </text>
        <box
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            height: 1,
            ...(codeBg ? { backgroundColor: codeBg } : {}),
          }}
        >
          <text selectable style={{ height: 1, width: "100%" }}>
            {segs && parsed.tone !== "header"
              ? syntaxMatchSpans(spans, segs, theme)
              : segs
              ? overlayPagerSegments([{ text: parsed.code }], segs).map((piece, i) => (
                  <span key={i} style={matchStyle(piece.kind, theme) ?? { fg: theme.muted }}>
                    {piece.text}
                  </span>
                ))
              : spans.map((sp, i) => (
                  <span
                    key={i}
                    style={{
                      fg:
                        parsed.tone === "header"
                          ? theme.muted
                          : syntaxColor(sp.kind, theme),
                    }}
                  >
                    {sp.text || (i === 0 ? " " : "")}
                  </span>
                ))}
          </text>
        </box>
      </box>
    );
  }

  const codeSpans = props.tone ? undefined : precomputedSpans;
  const baseFg = props.tone ? theme[pagerCommandColor(props.tone)] : baseLineFg(line, theme);
  const wrapProps = props.subagent ? { wrapMode: "word" as const } : {};
  if (!hasQuery || matches.length === 0) {
    if (codeSpans && codeSpans.length > 0) {
      return (
        <text
          id={`pager-line-${index}`}
          selectable
          style={{
            width: "100%",
            bg: isActiveLine ? theme.rowA : theme.background,
          }}
        >
          {codeSpans.map((sp, i) => (
            <span key={i} style={{ fg: syntaxColor(sp.kind, theme) }}>
              {sp.text || (i === 0 ? " " : "")}
            </span>
          ))}
        </text>
      );
    }
    return (
      <text
        id={`pager-line-${index}`}
        selectable
        {...wrapProps}
        style={{
          width: "100%",
          fg: baseFg,
          bg: isActiveLine ? theme.rowA : theme.background,
        }}
      >
        {line || " "}
      </text>
    );
  }

  const segments = segmentPagerLine(line, index, matches, activeMatchIndex);
  if (codeSpans && codeSpans.length > 0) {
    return (
      <text
        id={`pager-line-${index}`}
        selectable
        style={{ width: "100%", bg: isActiveLine ? theme.rowA : theme.background }}
      >
        {syntaxMatchSpans(codeSpans, segments, theme)}
      </text>
    );
  }
  return (
    <text
      id={`pager-line-${index}`}
      selectable
      {...wrapProps}
      style={{
        width: "100%",
        fg: baseFg,
        bg: isActiveLine ? theme.rowA : theme.background,
      }}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return (
            <span key={i} style={{ fg: baseFg }}>
              {seg.text}
            </span>
          );
        }
        if (seg.kind === "active") {
          return (
            <span
              key={i}
              style={{
                fg: theme.background,
                bg: theme.activity,
                attributes: TextAttributes.BOLD,
              }}
            >
              {seg.text}
            </span>
          );
        }
        return (
          <span
            key={i}
            style={{
              fg: theme.white,
              bg: theme.selection,
              attributes: TextAttributes.BOLD,
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </text>
  );
}
