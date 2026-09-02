/** @jsxImportSource @opentui/react */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { CompactedItem } from "../../../ui-core/state/transcript-types.js";
import { compactionTokenLabel } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import { displayCompactSummary } from "../../../ui-core/state/transcript-hydrate.js";
import {
  EMPTY_MARKDOWN_STREAM_CACHE,
  type MarkdownStreamCache,
} from "../../../ui-core/rendering/streaming-markdown.js";
import { renderStyledStreamingMarkdown } from "../../rendering/styled-markdown.js";
import { liveCompactionHeadTail } from "../../../ui-core/rendering/thinking-tail.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";
import { compactionElapsedLabel } from "../../../ui-core/rendering/duration.js";

const PREVIEW_LINES = 4;

export function CompactedRow(props: {
  item: CompactedItem;
  theme: Theme;
  services: AppServices;
  contentWidth?: number | undefined;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, services, contentWidth } = props;
  const colorMode = services.capabilities.colorMode;
  const { width: termWidth } = useTerminalDimensionsContext();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!item.streaming) return;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [item.streaming]);
  const elapsedLabel = compactionElapsedLabel(item, now);
  const wrapWidth = Math.max(
    20,
    contentWidth != null
      ? Math.max(20, contentWidth - 4)
      : Math.max(40, termWidth - 10),
  );
  const fullSummary = item.streaming
    ? item.summary
    : displayCompactSummary(item.summary);
  const visibleSummary = item.streaming
    ? liveCompactionHeadTail(fullSummary)
    : fullSummary;
  const cacheRef = useRef<MarkdownStreamCache>(EMPTY_MARKDOWN_STREAM_CACHE);
  const allLines = useMemo(() => {
    const rendered = renderStyledStreamingMarkdown({
      text: visibleSummary,
      streaming: item.streaming === true,
      options: {
        width: wrapWidth,
        defaultFg: theme.foreground,
        stripOuterIndent: true,
        theme,
        colorMode,
      },
      cache: cacheRef.current,
    });
    cacheRef.current = rendered.cache;
    return rendered.lines;
  }, [visibleSummary, item.streaming, wrapWidth, theme, colorMode]);

  const showLiveGap = item.streaming === true && allLines.length > 10;
  const preview = item.streaming
    ? showLiveGap
      ? [...allLines.slice(0, PREVIEW_LINES), ...allLines.slice(-6)]
      : allLines
    : allLines.slice(0, PREVIEW_LINES);
  const hidden = item.streaming
    ? Math.max(0, allLines.length - preview.length)
    : Math.max(0, allLines.length - PREVIEW_LINES);

  const tokenLabel = compactionTokenLabel(item);

  const openPager = (): void => {
    const title = item.streaming
      ? "Compacted context · streaming"
      : tokenLabel
        ? `Compacted context · ${tokenLabel}`
        : "Compacted context";
    services.overlay.openPager(title, fullSummary, undefined, undefined, "force");
  };

  const click = useClickWithoutDrag(openPager);

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
        <text
          content={`✦ Compacted context${item.streaming ? " …" : ""}${elapsedLabel ? ` · ${elapsedLabel}` : ""}`}
          selectable
          style={{ fg: borderFg, attributes: TextAttributes.BOLD }}
        />
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

      {preview.length > 0 || item.streaming ? (
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
            {item.streaming ? " STREAMING MARKDOWN " : " SUMMARY "}
          </text>
          {preview.length === 0 && item.streaming ? (
            <text selectable style={{ fg: theme.muted }}>
              │ Building compacted memory…
            </text>
          ) : null}
          {preview.map((content, i) => (
            <Fragment key={`l-${i}`}>
              {showLiveGap && i === PREVIEW_LINES ? (
                <text selectable style={{ width: "100%" }}>
                  <span style={{ fg: theme.muted }}>{"│ "}</span>
                  <span style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
                    {`··· ${hidden} streaming lines omitted ···`}
                  </span>
                </text>
              ) : null}
              <box style={{ flexDirection: "row", width: "100%" }}>
                <text selectable style={{ fg: theme.muted, flexShrink: 0 }}>
                  {"│ "}
                </text>
                <text
                  content={content ?? " "}
                  selectable
                  wrapMode="none"
                  style={{ width: "100%", flexGrow: 1 }}
                />
              </box>
            </Fragment>
          ))}
          {!item.streaming && hidden > 0 ? (
            <text selectable style={{ width: "100%" }}>
              <span style={{ fg: theme.muted }}>{"│ "}</span>
              <span style={{ fg: theme.muted, attributes: TextAttributes.DIM }}>
                {`··· ${hidden} more lines ···`}
              </span>
            </text>
          ) : null}
          {item.error ? (
            <text selectable style={{ fg: theme.diffDel }}>
              {`Compaction stopped: ${item.error}`}
            </text>
          ) : null}
        </box>
      ) : item.error ? (
        <text selectable style={{ fg: theme.diffDel }}>
          {`Compaction stopped: ${item.error}`}
        </text>
      ) : null}

      <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
        <text selectable={false} style={{ fg: theme.cyan }}>
          {"› "}
        </text>
        <text
          selectable={false}
          style={{ fg: theme.cyan, attributes: TextAttributes.DIM }}
        >
          {item.streaming
            ? "rendering bounded top + live tail · click for current memory"
            : item.error
              ? "original context retained · no compacted memory was applied"
              : "click or Ctrl+O to open full memory in pager"}
        </text>
      </box>
    </box>
  );
}
