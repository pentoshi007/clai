/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  segmentPagerLine,
  type PagerMatch,
} from "../../../ui-core/state/pager-search.js";
import { syntaxColor } from "../../../ui-core/rendering/file-diff-view.js";
import {
  emptyCarry,
  highlightLineForPath,
} from "../../../ui-core/rendering/syntax-highlight.js";
import type { PagerDisplayLine } from "../../rendering/pager-markdown.js";

const DIFF_SPLIT_RE = /^(?<gutter>[\d ]{0,8}) │ (?<rest>.*)$/;

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

export function parseDiffLine(line: string): {
  gutter: string;
  prefix: string;
  code: string;
  tone: "add" | "del" | "context" | "header";
} | null {
  const m = DIFF_SPLIT_RE.exec(line);
  if (!m?.groups) return null;
  const gutter = m.groups.gutter ?? "";
  const rest = m.groups.rest ?? "";
  if (/^[+\-−] /.test(rest)) {
    const prefix = rest[0]!;
    const code = rest.slice(2);
    const tone =
      prefix === "+" ? "add" : prefix === "-" || prefix === "−" ? "del" : "context";
    return { gutter, prefix, code, tone };
  }
  if (rest.startsWith("  ") || rest.startsWith(" ")) {
    if (rest[0] === " " && rest[1] === " ") {
      return { gutter, prefix: " ", code: rest.slice(2), tone: "context" };
    }
  }
  return { gutter, prefix: " ", code: rest, tone: "header" };
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

export function PagerLine(props: {
  line: string;
  index: number;
  theme: Theme;
  matches: readonly PagerMatch[];
  activeMatchIndex: number;
  hasQuery: boolean;
  highlightPath: string;
  carry: ReturnType<typeof emptyCarry>;
  styled?: PagerDisplayLine["styled"];
  markdownMode?: boolean | undefined;
}): ReactNode {
  const {
    line,
    index,
    theme,
    matches,
    activeMatchIndex,
    hasQuery,
    highlightPath,
    carry,
    styled,
    markdownMode,
  } = props;
  const isActiveLine =
    hasQuery &&
    activeMatchIndex >= 0 &&
    matches[activeMatchIndex]?.line === index;

  if (markdownMode) {
    const body = line.length > 0 ? line : " ";
    if (!hasQuery && styled) {
      return (
        <text
          id={`pager-line-${index}`}
          content={styled}
          selectable
          wrapMode="none"
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
        wrapMode="none"
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

  const parsed = parseDiffLine(line);

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
        : highlightLineForPath(parsed.code, highlightPath, carry);
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
            {segs
              ? segs.map((seg, i) => {
                  if (seg.kind === "plain") {
                    return (
                      <span key={i} style={{ fg: theme.foreground }}>
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
                })
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

  const baseFg = baseLineFg(line, theme);
  if (!hasQuery || matches.length === 0) {
    return (
      <text
        id={`pager-line-${index}`}
        selectable
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
  return (
    <text
      id={`pager-line-${index}`}
      selectable
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
