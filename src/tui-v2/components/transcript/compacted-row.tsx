/** @jsxImportSource @opentui/react */
/**
 * Compacted-context card — same shape as tool OUTPUT cards (CHAT-007).
 *
 * Auto and manual `/compact` both land here. Collapsed shows head + tail like
 * tool output; Ctrl+O (global output expand) or click expands/collapses in place.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { CompactedItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { displayCompactSummary } from "../../state/transcript-hydrate.js";
import { renderMarkdownLines } from "../../rendering/render-markdown-lines.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const COLLAPSED_HEAD = 4;
const COLLAPSED_TAIL = 4;

type BodyLine =
  | { readonly kind: "text"; readonly content: ReturnType<typeof renderMarkdownLines>[number] }
  | { readonly kind: "gap"; readonly hidden: number };

export function CompactedRow(props: {
  item: CompactedItem;
  theme: Theme;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
  /** Ctrl+O global / per-item expand (same flag as tool OUTPUT). */
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, contentWidth, expanded, onToggle } = props;
  const { width: termWidth } = useTerminalDimensions();
  // Card has border + horizontal padding (~4 cols of chrome).
  const wrapWidth = Math.max(
    20,
    contentWidth != null
      ? Math.max(20, contentWidth - 4)
      : Math.max(40, termWidth - 10),
  );
  const summary = displayCompactSummary(item.summary);

  const allLines = useMemo(
    () =>
      renderMarkdownLines(summary, {
        width: wrapWidth,
        defaultFg: theme.foreground,
        stripOuterIndent: true,
      }),
    [summary, wrapWidth, theme.foreground],
  );

  const bodyLines = useMemo((): BodyLine[] => {
    if (expanded || allLines.length <= COLLAPSED_HEAD + COLLAPSED_TAIL) {
      return allLines.map((content) => ({ kind: "text" as const, content }));
    }
    const hidden = allLines.length - COLLAPSED_HEAD - COLLAPSED_TAIL;
    const out: BodyLine[] = [];
    for (const content of allLines.slice(0, COLLAPSED_HEAD)) {
      out.push({ kind: "text", content });
    }
    out.push({ kind: "gap", hidden });
    for (const content of allLines.slice(-COLLAPSED_TAIL)) {
      out.push({ kind: "text", content });
    }
    return out;
  }, [allLines, expanded]);

  const hiddenCount = bodyLines.find((l) => l.kind === "gap")?.hidden ?? 0;

  const tokenLabel =
    item.beforeTokens > 0 || item.afterTokens > 0
      ? `~${item.beforeTokens.toLocaleString()} → ~${item.afterTokens.toLocaleString()} tokens`
      : "";

  const click = useClickWithoutDrag(() => {
    onToggle();
  });

  const footerHint = expanded
    ? "expanded · click or Ctrl+O to collapse"
    : hiddenCount > 0
      ? `+${hiddenCount} more · click or Ctrl+O to expand`
      : "click or Ctrl+O to expand";

  const borderFg = theme.activity;

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginBottom: 1,
        borderColor: borderFg,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        <text selectable style={{ fg: borderFg, attributes: TextAttributes.BOLD }}>
          ✦ Compacted context
        </text>
        <text content=" " selectable />
        <text
          selectable
          style={{
            fg: borderFg,
            bg: theme.chip,
            attributes: TextAttributes.BOLD,
          }}
        >
          {" memory "}
        </text>
        {tokenLabel ? (
          <>
            <text content=" " selectable />
            <text selectable style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
              {tokenLabel}
            </text>
          </>
        ) : null}
      </box>

      {bodyLines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <text
            selectable
            style={{
              fg: theme.white,
              bg: theme.chipTeal,
              attributes: TextAttributes.BOLD,
            }}
          >
            {" SUMMARY "}
          </text>
          {bodyLines.map((line, i) => {
            if (line.kind === "gap") {
              return (
                <text key={`gap-${i}`} selectable>
                  <span style={{ fg: theme.muted }}>{"│ "}</span>
                  <span style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
                    {`··· ${line.hidden} lines more ···`}
                  </span>
                </text>
              );
            }
            // Prefixed gutter like tool OUTPUT rows; markdown body is StyledText.
            return (
              <box key={`l-${i}`} style={{ flexDirection: "row", width: "100%" }}>
                <text selectable style={{ fg: theme.muted }}>
                  {"│ "}
                </text>
                <text content={line.content} selectable />
              </box>
            );
          })}
        </box>
      ) : null}

      <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
        <text selectable={false} style={{ fg: theme.cyan }}>
          {"› "}
        </text>
        <text
          selectable={false}
          style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}
        >
          {footerHint}
        </text>
      </box>
    </box>
  );
}
