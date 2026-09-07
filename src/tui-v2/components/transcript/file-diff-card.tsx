/** @jsxImportSource @opentui/react */

import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  clipDiffCardText,
  collapsedFileChangesLabel,
  diffCardMaxLineChars,
  gutterWidth,
  presentFileChangePreview,
  relativeDisplayPath,
  rowBackground,
  syntaxColor,
  type PresentedDiffRow,
} from "../../../ui-core/rendering/file-diff-view.js";
import type { FileChange } from "../../../tools/file-diff.js";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const SINGLE_FILE_PREVIEW_ROWS = 40;
const WRITE_MANY_PREVIEW_ROWS = 8;

/**
 * OpenTUI text renderables never clip at their box: an over-long line draws
 * straight through the card border (and re-wrapping hides the overflow).
 * Everything the diff card renders must therefore be pre-wrapped/clipped to
 * the real chat-pane width, never the raw terminal width.
 */
function diffPaneWidth(contentWidth: number | undefined, termWidth: number): number {
  return Math.max(20, contentWidth ?? termWidth - 6);
}

export function DiffActionButton(props: {
  label: string;
  theme: Theme;
  onClick: () => void;
}): ReactNode {
  const { label, theme, onClick } = props;
  const [hovered, setHovered] = useState(false);
  const fg = hovered ? theme.white : theme.muted;
  const bg = hovered ? theme.selection : theme.statusBackground;
  return (
    <box
      onMouseDown={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      onMouseUp={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        height: 1,
        backgroundColor: bg,
        marginLeft: 1,
      }}
    >
      <text
        selectable={false}
        content={hovered ? ` ${label} ` : ` ${label} `}
        style={{
          fg,
          bg,
          attributes: hovered ? TextAttributes.BOLD : TextAttributes.NONE,
        }}
      />
    </box>
  );
}

function DiffCodeRow(props: {
  gutter: string;
  spans: readonly {
    kind: import("../../../ui-core/rendering/syntax-highlight.js").SyntaxKind;
    text: string;
  }[];
  displayText: string;
  tone: "context" | "add" | "del" | "gap" | "header";
  theme: Theme;
}): ReactNode {
  const { gutter, spans, displayText, tone, theme } = props;
  const bg = rowBackground(tone, theme);
  const isGap = tone === "gap" || tone === "header";
  const gutterFg = theme.diffGutter;
  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: 1,
        flexShrink: 0,
        backgroundColor: bg ?? theme.statusBackground,
      }}
    >
      <text selectable={false} style={{ height: 1 }}>
        <span style={{ fg: gutterFg }}>{gutter}</span>
        <span style={{ fg: gutterFg }}>{" │ "}</span>
      </text>
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          height: 1,
          ...(bg ? { backgroundColor: bg } : {}),
        }}
      >
        <text
          selectable={!isGap}
          style={{
            height: 1,
            attributes: isGap ? TextAttributes.DIM : TextAttributes.NONE,
          }}
        >
          {isGap ? (
            <span style={{ fg: theme.muted }}>{displayText}</span>
          ) : spans.length > 0 ? (
            spans.map((sp, si) => (
              <span key={si} style={{ fg: syntaxColor(sp.kind, theme) }}>
                {sp.text}
              </span>
            ))
          ) : (
            <span style={{ fg: theme.foreground }}>{displayText || " "}</span>
          )}
        </text>
      </box>
    </box>
  );
}

function clipPresentedRow(row: PresentedDiffRow, max: number): PresentedDiffRow {
  if (row.displayText.length <= max) return row;
  const clipped = clipDiffCardText(row.displayText, max);
  return { ...row, displayText: clipped, spans: [{ kind: "plain", text: clipped }] };
}

function FileDiffHunks(props: {
  change: FileChange;
  showPath: boolean;
  theme: Theme;
  onOpen: (change: FileChange) => void;
  maxRows?: number;
  paneWidth: number;
}): ReactNode {
  const {
    change,
    showPath,
    theme,
    onOpen,
    maxRows = SINGLE_FILE_PREVIEW_ROWS,
    paneWidth,
  } = props;
  const open = useClickWithoutDrag(() => onOpen(change));
  const mark =
    change.kind === "create" ? "+" : change.kind === "overwrite" ? "~" : "·";
  const markFg =
    change.kind === "create"
      ? theme.success
      : change.kind === "overwrite"
        ? theme.activity
        : theme.toolOutput;

  const gutterChars = gutterWidth(change);
  const maxLineChars = diffCardMaxLineChars(paneWidth, gutterChars);
  const rows = presentFileChangePreview(change, { maxRows, maxLineChars }).map((row) =>
    row.tone === "gap" || row.tone === "header" ? clipPresentedRow(row, maxLineChars) : row,
  );
  return (
    <box
      style={{ flexDirection: "column", width: "100%" }}
      onMouseDown={open.onMouseDown}
      onMouseUp={open.onMouseUp}
    >
      {showPath ? (
        <text selectable style={{ height: 1 }}>
          <span style={{ fg: markFg }}>{` ${mark} `}</span>
          <span style={{ fg: theme.inputBorder }}>
            {clipDiffCardText(relativeDisplayPath(change.path), paneWidth - 7)}
          </span>
        </text>
      ) : null}
      {rows.map((row, ri) => (
        <DiffCodeRow
          key={ri}
          gutter={row.gutter}
          spans={row.spans}
          displayText={row.displayText}
          tone={row.tone}
          theme={theme}
        />
      ))}
    </box>
  );
}

function WriteManyCollapsedRow(props: {
  change: FileChange;
  theme: Theme;
  onOpen: (change: FileChange) => void;
  paneWidth: number;
}): ReactNode {
  const { change, theme, onOpen, paneWidth } = props;
  const open = useClickWithoutDrag(() => onOpen(change));
  const mark =
    change.kind === "create" ? "+" : change.kind === "overwrite" ? "~" : "·";
  const markFg =
    change.kind === "create"
      ? theme.success
      : change.kind === "overwrite"
        ? theme.activity
        : theme.toolOutput;
  return (
    <text
      selectable
      style={{ height: 1 }}
      onMouseDown={open.onMouseDown}
      onMouseUp={open.onMouseUp}
    >
      <span style={{ fg: markFg }}>{` ${mark} `}</span>
      <span style={{ fg: theme.inputBorder }}>
        {clipDiffCardText(relativeDisplayPath(change.path), paneWidth - 7)}
      </span>
    </text>
  );
}

export function FileDiffBody(props: {
  changes: readonly FileChange[];
  theme: Theme;
  diffExpanded: boolean;
  onOpen: (change: FileChange) => void;
  multiFilePreview?: boolean;
  contentWidth?: number | undefined;
}): ReactNode {
  const {
    changes,
    theme,
    diffExpanded,
    onOpen,
    multiFilePreview = false,
    contentWidth,
  } = props;
  const { width: termWidth } = useTerminalDimensionsContext();
  const paneWidth = diffPaneWidth(contentWidth, termWidth);

  const label = clipDiffCardText(collapsedFileChangesLabel(changes), paneWidth - 4);
  const openPrimary = useClickWithoutDrag(() => {
    if (changes[0]) onOpen(changes[0]!);
  });

  const showHunks = diffExpanded;
  const maxRows = multiFilePreview
    ? WRITE_MANY_PREVIEW_ROWS
    : SINGLE_FILE_PREVIEW_ROWS;

  return (
    <box style={{ flexDirection: "column", width: "100%", marginTop: 0 }}>
      {!multiFilePreview ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            height: 1,
            flexShrink: 0,
          }}
          onMouseDown={openPrimary.onMouseDown}
          onMouseUp={openPrimary.onMouseUp}
        >
          <text
            selectable
            style={{
              height: 1,
              fg: theme.foreground,
              attributes: TextAttributes.BOLD,
            }}
          >
            {label}
          </text>
        </box>
      ) : null}

      {showHunks
        ? changes.map((change, ci) => (
            <FileDiffHunks
              key={`${change.path}-${ci}`}
              change={change}
              showPath={multiFilePreview || changes.length > 1}
              theme={theme}
              onOpen={onOpen}
              maxRows={maxRows}
              paneWidth={paneWidth}
            />
          ))
        : multiFilePreview
          ? changes.map((change, ci) => (
              <WriteManyCollapsedRow
                key={`wm-c-${ci}`}
                change={change}
                theme={theme}
                onOpen={onOpen}
                paneWidth={paneWidth}
              />
            ))
          : null}
    </box>
  );
}
