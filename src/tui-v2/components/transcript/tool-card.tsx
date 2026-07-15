/** @jsxImportSource @opentui/react */
/**
 * Tool card: flat single-border pane (classic parity — no 3D depth / outer plate).
 *
 * Click (body or footer) opens the full-output pager modal — unless the card is
 * already expanded in place via Ctrl+O. Ctrl+O expands every card to show the
 * full cleaned body; click does not toggle expand (classic: keyboard expands,
 * click opens the unbounded viewer).
 *
 * tool.batch: parent card nests one mini-card per sub-tool. Click the parent
 * (header/footer) for the full batch; click a sub-card for that call only.
 * Ctrl+O expands sub-bodies in place the same as a normal tool.
 */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { OutputSpool } from "../../../app/events/event-buffer.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { ToolItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import {
  batchSummaryLine,
  formatBatchSectionForPager,
  isBatchToolName,
  parseBatchSections,
  presentBatchSection,
  type BatchSection,
} from "../../rendering/batch-sections.js";
import { presentOutput, presentTool } from "../../rendering/tool-presenter.js";
import { openToolOutputPager } from "../../rendering/open-tool-output.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const STATUS_COLOR: Record<ToolItem["status"], keyof Theme> = {
  running: "activity",
  ok: "response",
  failed: "mode",
  blocked: "mode",
};

function OutputLines(props: {
  lines: readonly string[];
  theme: Theme;
  gutterFg: string;
}): ReactNode {
  const { lines, theme, gutterFg } = props;
  // Tool/output body: CLAI wordmark magenta (same as task-pane border / logo "I").
  const bodyFg = theme.magenta;
  return (
    <>
      {lines.map((line, i) => {
        const isGap = line.startsWith("···");
        return (
          // Selectable so drag-select includes tool output in the copy range.
          <text key={i} selectable>
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
  const borderFg = section.ok ? theme.response : theme.mode;
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
          <OutputLines lines={presented.lines} theme={theme} gutterFg={borderFg} />
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
}): ReactNode {
  const { item, theme, spool, expanded, services } = props;
  const { glyph, statusLabel, name, argsLabel, argsDisplay, detail } = presentTool(item);
  const tail = spool.tail(item.toolCallId);
  const spoolState = spool.state(item.toolCallId);

  const batchSections =
    isBatchToolName(item.name) && item.status !== "running" && tail
      ? parseBatchSections(tail)
      : [];
  const isBatch = batchSections.length > 0;

  const { lines, hiddenAboveCount, truncatedNotice } = isBatch
    ? { lines: [] as string[], hiddenAboveCount: 0, truncatedNotice: undefined as string | undefined }
    : presentOutput(tail, spoolState, expanded);

  const statusFg = theme[STATUS_COLOR[item.status]];
  const highlight =
    item.status === "running"
      ? theme.activity
      : item.status === "ok"
        ? theme.toolBorder
        : theme.mode;

  const hasBody =
    isBatch ||
    lines.length > 0 ||
    item.outputBytes > 0 ||
    Boolean(item.artifactPath);

  /** Open unbounded pager for the whole tool (or full batch). */
  const openFull = (): void => {
    if (expanded) return;
    if (item.status === "running" && !hasBody) return;
    void openToolOutputPager(services, item);
  };
  // Click without drag opens pager; drag-select includes output text.
  const openFullClick = useClickWithoutDrag(openFull);

  const openSection = (section: BatchSection): void => {
    void openToolOutputPager(
      services,
      {
        toolCallId: item.toolCallId,
        name: section.name,
        argsDisplay: `#${section.index}`,
        artifactPath: undefined,
      },
      {
        bodyOverride: formatBatchSectionForPager(section),
        titleOverride: `${section.name} · #${section.index}`,
        skipArtifact: true,
      },
    );
  };

  // Footer: keyboard expand always advertised; click-for-modal only when collapsed.
  let footerHint: string | undefined;
  if (item.status !== "running" && hasBody) {
    if (expanded) {
      footerHint = isBatch
        ? "expanded · Ctrl+O to collapse · click a sub-tool for its full output"
        : "expanded · Ctrl+O to collapse";
    } else if (isBatch) {
      footerHint = "click batch for full · click a sub-tool · Ctrl+O to expand";
    } else if (hiddenAboveCount > 0) {
      footerHint = `+${hiddenAboveCount} more · click for full · Ctrl+O to expand`;
    } else {
      footerHint = "click for full · Ctrl+O to expand";
    }
  } else if (item.status === "running" && hasBody && !expanded) {
    footerHint = "click for full · Ctrl+O to expand";
  }

  const summary = isBatch ? batchSummaryLine(batchSections) : undefined;
  const summaryFg =
    isBatch && batchSections.some((s) => !s.ok) ? theme.mode : theme.muted;

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
      {/* Header: name + status pill. Click opens full tool/batch pager. */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          paddingTop: 0,
          paddingBottom: 0,
        }}
        onMouseDown={openFullClick.onMouseDown}
        onMouseUp={openFullClick.onMouseUp}
      >
        <text selectable style={{ fg: statusFg, attributes: TextAttributes.BOLD }}>
          {glyph} {name}
        </text>
        <text content=" " selectable />
        <text selectable style={{ fg: statusFg, bg: theme.chip, attributes: TextAttributes.BOLD }}>
          {` ${statusLabel} `}
        </text>
        {isBatch ? (
          <>
            <text content=" " selectable />
            <text selectable style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
              batch
            </text>
          </>
        ) : null}
      </box>

      {argsDisplay && argsLabel ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable style={{ fg: theme.muted }}>{argsLabel}: </text>
          {/* Aqua input/command text — stands out from muted labels + white output. */}
          <text selectable style={{ fg: theme.cyan }}>{argsDisplay}</text>
        </box>
      ) : null}
      {detail ? <LinkableText text={detail} theme={theme} fg={theme.mode} selectable /> : null}

      {summary ? (
        <text selectable style={{ fg: summaryFg, attributes: TextAttributes.DIM }}>{summary}</text>
      ) : null}

      {/* Nested sub-tools for tool.batch */}
      {isBatch
        ? batchSections.map((section) => (
            <BatchSubCard
              key={`${item.id}-sub-${section.index}`}
              section={section}
              theme={theme}
              expanded={expanded}
              parentExpanded={expanded}
              onOpen={openSection}
            />
          ))
        : null}

      {/* Normal (non-batch) output body — click opens pager; drag selects. */}
      {!isBatch && lines.length > 0 ? (
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
          <text selectable style={{ fg: theme.white, bg: theme.chipTeal, attributes: TextAttributes.BOLD }}>
            {" OUTPUT "}
          </text>
          <OutputLines lines={lines} theme={theme} gutterFg={theme.muted} />
        </box>
      ) : null}

      {item.artifactPath ? (
        <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
          <text selectable style={{ fg: theme.white, bg: theme.chipTeal, attributes: TextAttributes.BOLD }}>
            {" SAVED "}
          </text>
          <text content=" " selectable />
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
