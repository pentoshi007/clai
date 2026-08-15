/** @jsxImportSource @opentui/react */
/**
 * Tool card: flat single-border pane (classic parity — no 3D depth / outer plate).
 *
 * Click (body or footer) opens the full-output pager modal — unless the card is
 * already expanded in place via Ctrl+O. Ctrl+O expands every card to show the
 * full cleaned body; click does not toggle expand (classic: keyboard expands,
 * click opens the unbounded viewer).
 *
 * tool.batch: parent card nests one mini-card per sub-tool **while live and
 * after completion**. As each child settles, its full section body streams in
 * so nested cards look like normal expanded tool output (not a compact
 * "x ok, y ok" status list). Click the parent for the full batch; click a
 * sub-card for that call only. Ctrl+O expands sub-bodies in place.
 *
 * File diffs: compact single-height rows; chevron collapses hunks to a one-line
 * title (verb + relative path). Collapse-all applies to every file-diff card.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { ToolItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  batchSummaryLine,
  buildBatchCardsFromSpool,
  formatBatchSectionForPager,
  isBatchToolName,
  presentBatchSection,
  type BatchSection,
} from "../../../ui-core/rendering/batch-sections.js";
import { presentOutput, presentTool } from "../../../ui-core/rendering/tool-presenter.js";
import { toolElapsedLabel } from "../../../ui-core/rendering/duration.js";
import {
  openToolOutputPager,
  pathFromArgsDisplay,
} from "../../../ui-core/rendering/open-tool-output.js";
import {
  isFileMutationTool,
  type FileChange,
} from "../../../tools/file-diff.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";
import { DiffActionButton, FileDiffBody } from "./file-diff-card.js";
import { renderStyledMarkdownLines } from "../../rendering/styled-markdown.js";
import { shouldDefaultFormattedView } from "../../../ui-core/rendering/pager-view-policy.js";
import { extractFsReadFileBody } from "../../../ui-core/rendering/pager-source.js";
import { selectableRowStyle } from "./selectable-line.js";

/** Border / status accent: green ok · yellow running · red failed. */
const STATUS_COLOR: Record<ToolItem["status"], keyof Theme> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "diffDel",
};

function fileChangeLineStats(
  changes: readonly FileChange[] | undefined,
): { added: number; removed: number } | undefined {
  if (!changes?.length) return undefined;
  return changes.reduce(
    (totals, change) => ({
      added: totals.added + change.stats.added,
      removed: totals.removed + change.stats.removed,
    }),
    { added: 0, removed: 0 },
  );
}

function OutputLines(props: {
  lines: readonly string[];
  theme: Theme;
  gutterFg: string;
}): ReactNode {
  const { lines, theme, gutterFg } = props;
  // Sky cyan body — readable on dark tool cards (theme.toolOutput).
  const bodyFg = theme.toolOutput;
  return (
    <>
      {lines.map((line, i) => {
        const isGap = line.startsWith("···");
        return (
          // Full-width row so drag-select does not require pixel-perfect aim,
          // opaque so a short line repaints the cells to its right.
          <text
            key={i}
            selectable
            style={{ height: 1, width: "100%", bg: theme.statusBackground }}
          >
            <span style={{ fg: isGap ? theme.muted : gutterFg }}>{"│ "}</span>
            <span
              style={{
                fg: isGap ? theme.muted : bodyFg,
                attributes: isGap ? TextAttributes.DIM : TextAttributes.NONE,
              }}
            >
              {line}
            </span>
          </text>
        );
      })}
    </>
  );
}

function BatchSubCard(props: {
  section: BatchSection;
  theme: Theme;
  expanded: boolean;
  parentExpanded: boolean;
  onOpen: (section: BatchSection) => void;
}): ReactNode {
  const { section, theme, expanded, parentExpanded, onOpen } = props;
  const presented = presentBatchSection(section, expanded);
  const status = section.status ?? (section.ok ? "ok" : "fail");
  const borderFg =
    status === "running"
      ? theme.activity
      : status === "ok"
        ? theme.success
        : status === "cancelled"
          ? theme.muted
          : theme.diffDel;
  const statusFg = borderFg;

  // Click (no drag) opens pager; drag-select copies output lines.
  const click = useClickWithoutDrag(() => {
    if (parentExpanded) return;
    onOpen(section);
  });

  let footerHint: string | undefined;
  if (presented.hasBody) {
    if (expanded) {
      footerHint = "expanded · Ctrl+O to collapse";
    } else if (presented.hiddenAboveCount > 0) {
      footerHint = `+${presented.hiddenAboveCount} more · click for full · Ctrl+O to expand`;
    } else {
      footerHint = "click for full · Ctrl+O to expand";
    }
  }

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginTop: 1,
        marginBottom: 0,
        borderColor: borderFg,
        // Match parent face — no second elevated plate.
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text selectable style={{ fg: statusFg, attributes: TextAttributes.BOLD }}>
          {presented.glyph} {presented.name}
        </text>
        <text content=" " selectable />
        <text selectable style={{ fg: statusFg, bg: theme.chip, attributes: TextAttributes.BOLD }}>
          {` ${presented.statusLabel} `}
        </text>
        <text content=" " selectable />
        <text selectable style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
          #{section.index}
        </text>
      </box>

      {presented.lines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <OutputLines lines={presented.lines} theme={theme} gutterFg={theme.toolOutput} />
        </box>
      ) : null}

      {footerHint ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable={false} style={{ fg: theme.cyan }}>{"› "}</text>
          <text selectable={false} style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}>{footerHint}</text>
        </box>
      ) : null}
    </box>
  );
}

export function ToolCard(props: {
  item: ToolItem;
  theme: Theme;
  spool: OutputSpool;
  expanded: boolean;
  services: AppServices;
  onToggle: () => void;
  /** Collapse/expand every tool OUTPUT card (collapse all / expand all). */
  onCollapseAllOutput?: () => void;
  onExpandAllOutput?: () => void;
  /** File-diff hunks visible (vs one-line collapsed title). */
  fileDiffExpanded?: boolean;
  onToggleFileDiff?: () => void;
  onCollapseAllFileDiffs?: () => void;
  onExpandAllFileDiffs?: () => void;
}): ReactNode {
  const {
    item,
    theme,
    spool,
    expanded,
    services,
    onToggle,
    onCollapseAllOutput,
    onExpandAllOutput,
    fileDiffExpanded = true,
    onToggleFileDiff,
    onCollapseAllFileDiffs,
    onExpandAllFileDiffs,
  } = props;
  const { glyph, statusLabel, name, argsLabel, argsDisplay, detail, pathLine, isFileDiff } =
    presentTool(item);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (item.status !== "running" && item.status !== "queued") return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [item.status]);
  const elapsedLabel = toolElapsedLabel(item, now);
  const tail = spool.tail(item.toolCallId);
  const spoolState = spool.state(item.toolCallId);
  const fileChanges = item.fileChanges;
  const fileChangeStats = fileChangeLineStats(fileChanges);
  const isWriteMany = item.name === "fs.writeMany";
  // File mutations never show the spool receipt ("Tool fs.write result…") —
  // that is what made history cards look broken when fileChanges was missing.
  const isMutation = isFileMutationTool(item.name);

  const isBatchName = isBatchToolName(item.name);
  // Live + finished: merge streamed `── #N` sections with running placeholders
  // so nested cards appear as soon as the first child starts (expanded form).
  const batchSections =
    isBatchName && tail ? buildBatchCardsFromSpool(tail) : [];
  const isBatch = isBatchName && batchSections.length > 0;
  const isBatchLive = isBatchName && item.status === "running";
  // Nested batch bodies prefer expanded presentation so live output matches
  // single-tool cards (Ctrl+O still toggles global expand for huge dumps).
  const batchExpanded = expanded || isBatchLive;

  const { width: termWidth } = useTerminalDimensions();
  const readPath = pathFromArgsDisplay(item.argsDisplay);
  // fs.read of markdown: prefer formatted preview (same policy as pager).
  const formatMdRead =
    !isBatch &&
    !isBatchLive &&
    !isFileDiff &&
    !isMutation &&
    shouldDefaultFormattedView({
      kind: "tool",
      toolName: item.name,
      path: readPath,
      body: tail,
    });
  const mdPreview = useMemo(() => {
    if (!formatMdRead || !tail.trim()) return null;
    // Spool is tool chrome + `N: ` line numbers — strip to real markdown first.
    const clean = extractFsReadFileBody(tail);
    if (!clean.trim()) return null;
    const budget = expanded ? 60 : 10;
    return renderStyledMarkdownLines(clean, {
      width: Math.max(24, termWidth - 12),
      defaultFg: theme.toolOutput,
      stripOuterIndent: true,
    }).slice(0, budget);
  }, [formatMdRead, tail, expanded, termWidth, theme.toolOutput]);

  // write/edit/writeMany: structured body only — never receipt dumps.
  const { lines, hiddenAboveCount, truncatedNotice } =
    isBatch || isBatchLive || isFileDiff || isWriteMany || isMutation || formatMdRead
      ? {
          lines: [] as string[],
          hiddenAboveCount: 0,
          truncatedNotice: undefined as string | undefined,
        }
      : presentOutput(tail, spoolState, expanded, item.name);

  const statusFg = theme[STATUS_COLOR[item.status]];
  // Card boundary: green success · yellow running · red failure · muted queued.
  const highlight = statusFg;
  // Status chips: dark solid plates (bright colors stay on title/border only).
  const statusBadgeBg =
    item.status === "ok"
      ? theme.successBg
      : item.status === "failed" || item.status === "blocked"
        ? theme.failedBg
        : item.status === "running"
          ? theme.activityBg
          : theme.chip;

  const hasWriteManyBody =
    isWriteMany && Boolean(fileChanges && fileChanges.length > 0);
  const hasBody =
    isBatch ||
    isBatchLive ||
    (isFileDiff && !isWriteMany) ||
    hasWriteManyBody ||
    lines.length > 0 ||
    Boolean(mdPreview && mdPreview.length > 0) ||
    item.outputBytes > 0 ||
    Boolean(item.artifactPath);

  // shell.exec-style OUTPUT cards get collapse / collapse-all chips (parity
  // with file-diff cards). Shown only when there is genuinely collapsible
  // body — expanded, or collapsed with more lines hidden.
  const canToggleOutput =
    !isFileDiff &&
    !isBatch &&
    !isBatchLive &&
    hasBody &&
    (expanded ||
      hiddenAboveCount > 0 ||
      (formatMdRead && (mdPreview?.length ?? 0) > 0));

  /** Open unbounded pager for the whole tool (or full batch / file diff). */
  const openFull = (): void => {
    if (expanded) return;
    if (item.status === "running" && !hasBody) return;
    void openToolOutputPager(services, item);
  };
  // Click without drag opens pager; drag-select includes output text.
  const openFullClick = useClickWithoutDrag(openFull);

  const openFileChange = (change: FileChange): void => {
    if (expanded) return;
    void openToolOutputPager(services, item, { fileChange: change });
  };

  const openSection = (section: BatchSection): void => {
    void openToolOutputPager(
      services,
      {
        toolCallId: item.toolCallId,
        name: section.name,
        argsDisplay: `#${section.index}`,
        artifactPath: undefined,
        fileChanges: undefined,
      },
      {
        bodyOverride: formatBatchSectionForPager(section),
        titleOverride: `${section.name} · #${section.index}`,
        skipArtifact: true,
      },
    );
  };

  // Footer: shorter for file diffs (title already carries the path).
  let footerHint: string | undefined;
  if (isWriteMany && item.status !== "running") {
    const n = fileChanges?.length ?? 0;
    // Hide the ghost "0 files" footer on empty/failed multi-writes.
    footerHint =
      n > 0
        ? fileDiffExpanded
          ? `${n} file${n === 1 ? "" : "s"} · click hunk · open file`
          : `${n} file${n === 1 ? "" : "s"} · expand for diffs · click for full`
        : item.status === "failed" || item.status === "blocked"
          ? "write failed · click for details"
          : undefined;
  } else if (isFileDiff && !isWriteMany && item.status !== "running") {
    footerHint = fileDiffExpanded
      ? "click hunk · open file"
      : "click title · open file";
  } else if (item.status !== "running" && hasBody) {
    if (expanded) {
      footerHint = isBatch
        ? "sub-calls expanded · click batch or sub-tool for pager · Ctrl+O collapses"
        : "expanded · Ctrl+O to collapse";
    } else if (isBatch) {
      footerHint =
        "click batch = all output · click sub-tool = that call · Ctrl+O expands all";
    } else if (hiddenAboveCount > 0) {
      footerHint = `+${hiddenAboveCount} more · click for full · Ctrl+O to expand`;
    } else {
      footerHint = "click for full · Ctrl+O to expand";
    }
  } else if (isBatchLive) {
    footerHint =
      "live nested sub-tools · outputs appear as each call finishes · Ctrl+O expands further";
  } else if (item.status === "running" && hasBody && !expanded) {
    footerHint = "click for full · Ctrl+O to expand";
  }

  const summary = isBatch ? batchSummaryLine(batchSections) : undefined;
  const summaryFg =
    isBatch &&
    batchSections.some((s) => s.status === "fail" || s.status === "cancelled")
      ? theme.mode
      : theme.muted;

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "100%",
        marginBottom: 1,
        borderColor: highlight,
        // Flat face only — no layered header/well plate outside the border.
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {/* Header: title (shrinks) + short status badge (never overflows border).
          height:1 + no padding so no air gap before command/args line. */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          paddingTop: 0,
          paddingBottom: 0,
          marginTop: 0,
          marginBottom: 0,
          alignItems: "center",
        }}
      >
        <box
          style={{
            flexDirection: "row",
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
          }}
          onMouseDown={openFullClick.onMouseDown}
          onMouseUp={openFullClick.onMouseUp}
        >
          <text
            selectable
            content={`${glyph} ${name}`}
            style={{
              fg: statusFg,
              attributes: TextAttributes.BOLD,
              flexShrink: 1,
            }}
          />
          {elapsedLabel ? (
            <text
              selectable={false}
              content={` · ${elapsedLabel}`}
              style={{ fg: theme.muted, flexShrink: 0 }}
            />
          ) : null}
        </box>
        {isFileDiff && fileChangeStats ? (
          <box
            style={{
              flexDirection: "row",
              flexShrink: 0,
              alignItems: "center",
            }}
          >
            <text
              selectable={false}
              content={`+${fileChangeStats.added}`}
              style={{ fg: theme.success, attributes: TextAttributes.BOLD }}
            />
            <text content=" " selectable={false} />
            <text
              selectable={false}
              content={`-${fileChangeStats.removed}`}
              style={{ fg: theme.diffDel, attributes: TextAttributes.BOLD }}
            />
          </box>
        ) : null}
        <text content=" " selectable={false} style={{ flexShrink: 0 }} />
        <text
          selectable={false}
          content={` ${statusLabel} `}
          style={{
            fg: theme.white,
            bg: statusBadgeBg,
            attributes: TextAttributes.BOLD,
            flexShrink: 0,
          }}
        />
        {isFileDiff ? (
          <>
            <DiffActionButton
              label={fileDiffExpanded ? "collapse" : "expand"}
              theme={theme}
              onClick={() => onToggleFileDiff?.()}
            />
            <DiffActionButton
              label={fileDiffExpanded ? "collapse all" : "expand all"}
              theme={theme}
              onClick={() =>
                fileDiffExpanded
                  ? onCollapseAllFileDiffs?.()
                  : onExpandAllFileDiffs?.()
              }
            />
          </>
        ) : null}
        {canToggleOutput ? (
          <>
            <DiffActionButton
              label={expanded ? "collapse" : "expand"}
              theme={theme}
              onClick={() => onToggle()}
            />
            <DiffActionButton
              label={expanded ? "collapse all" : "expand all"}
              theme={theme}
              onClick={() =>
                expanded ? onCollapseAllOutput?.() : onExpandAllOutput?.()
              }
            />
          </>
        ) : null}
        {isBatch || isBatchLive ? (
          <>
            <text content=" " selectable={false} />
            <text selectable={false} style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
              batch
            </text>
          </>
        ) : null}
      </box>

      {argsDisplay && argsLabel ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            marginTop: 0,
            marginBottom: 0,
            paddingTop: 0,
            flexShrink: 0,
          }}
        >
          <text selectable style={{ fg: theme.muted }}>
            {argsLabel}:{" "}
          </text>
          {/* Input/command — composer aqua; OUTPUT body uses toolOutput sky. */}
          <text selectable style={{ fg: theme.inputBorder }}>
            {argsDisplay}
          </text>
        </box>
      ) : null}
      {pathLine && !isFileDiff ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <LinkableText text={pathLine} theme={theme} fg={theme.muted} selectable />
        </box>
      ) : null}
      {detail ? <LinkableText text={detail} theme={theme} fg={theme.mode} selectable /> : null}

      {summary ? (
        <text selectable style={{ fg: summaryFg, attributes: TextAttributes.DIM }}>{summary}</text>
      ) : null}

      {/* Nested sub-tools for tool.batch — live and finished (expanded form). */}
      {isBatch
        ? batchSections.map((section) => (
            <BatchSubCard
              key={`${item.id}-sub-${section.index}`}
              section={section}
              theme={theme}
              expanded={batchExpanded}
              parentExpanded={batchExpanded}
              onOpen={openSection}
            />
          ))
        : null}

      {/* writeMany + single-file mutations: green/red hunk previews (not name-only lists). */}
      {!isBatch && !isBatchLive && isFileDiff && fileChanges && fileChanges[0]?.kind !== "delete" ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            marginTop: 0,
            flexShrink: 1,
          }}
        >
          <FileDiffBody
            changes={isWriteMany ? fileChanges.slice(0, 12) : fileChanges}
            theme={theme}
            diffExpanded={fileDiffExpanded}
            multiFilePreview={isWriteMany}
            onOpen={openFileChange}
          />
          {isWriteMany && fileChanges.length > 12 ? (
            <text
              selectable
              content={` ··· +${fileChanges.length - 12} more files · click for full ···`}
              style={{ fg: theme.muted, height: 1 }}
            />
          ) : null}
        </box>
      ) : null}

      {/* Normal (non-batch) output body — click opens pager; drag selects. */}
      {!isBatch &&
      !isBatchLive &&
      !isFileDiff &&
      (lines.length > 0 || (mdPreview && mdPreview.length > 0)) ? (
        <box
          style={{
            flexDirection: "column",
            width: "100%",
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            marginTop: 0,
            flexShrink: 1,
          }}
          onMouseDown={openFullClick.onMouseDown}
          onMouseUp={openFullClick.onMouseUp}
        >
          <text
            selectable
            style={{
              fg: theme.white,
              bg: theme.chipTeal,
              attributes: TextAttributes.BOLD,
              height: 1,
            }}
          >
            {formatMdRead ? " OUTPUT · formatted " : " OUTPUT "}
          </text>
          {mdPreview && mdPreview.length > 0 ? (
            mdPreview.map((content, i) => (
              <text
                key={`md-${i}`}
                content={content ?? " "}
                selectable
                wrapMode="none"
                style={selectableRowStyle(theme.statusBackground)}
              />
            ))
          ) : (
            <OutputLines lines={lines} theme={theme} gutterFg={theme.toolOutput} />
          )}
        </box>
      ) : null}

      {/* Skip the saved-path line for file mutations — path is already in the title. */}
      {item.artifactPath && !isFileDiff && !isMutation ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            marginTop: 0,
            height: 1,
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          <LinkableText text={item.artifactPath} theme={theme} fg={theme.cyan} selectable />
        </box>
      ) : null}
      {truncatedNotice ? (
        <text selectable style={{ fg: theme.muted, attributes: TextAttributes.ITALIC }}>
          {truncatedNotice}
        </text>
      ) : null}
      {footerHint ? (
        <box
          style={{
            flexDirection: "row",
            width: "100%",
            marginTop: 0,
            marginBottom: 0,
            paddingBottom: 0,
            height: 1,
            flexShrink: 0,
            overflow: "hidden",
          }}
          {...(expanded
            ? {}
            : {
                onMouseDown: openFullClick.onMouseDown,
                onMouseUp: openFullClick.onMouseUp,
              })}
        >
          <text selectable={false} style={{ fg: theme.cyan }}>{"› "}</text>
          <text selectable={false} style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}>{footerHint}</text>
        </box>
      ) : null}
    </box>
  );
}
