/** @jsxImportSource @opentui/react */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  TextAttributes,
  type BoxRenderable,
  type MouseEvent,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { renderColumns } from "../../../ui-core/rendering/text-width.js";
import { sanitizeDisplayText } from "../../../ui-core/rendering/sanitize-display.js";
import { thinkingElapsedLabel } from "../../../ui-core/rendering/duration.js";
import type { ThinkingItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  createLiveThinkingWrap,
  resolveThinkingFooter,
  resolveThinkingHeadingStyle,
  resolveThinkingPresentation,
  resolveThinkingViewport,
  THINKING_BODY_MAX_ROWS,
  wrapThinkingBody,
} from "./thinking-presentation.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const WHEEL_ROWS = 3;
const DRAG_SCROLL_ROWS = 2;
const DRAG_SCROLL_MS = 45;

export function ThinkingBlock(props: {
  item: ThinkingItem;
  theme: Theme;
  expanded: boolean;
  contentWidth?: number | undefined;
  onToggle: () => void;
  focused?: boolean | undefined;
  onFocus?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
}): ReactNode {
  const {
    item,
    theme,
    expanded,
    contentWidth,
    onToggle,
    focused = false,
    onFocus,
    onBlur,
  } = props;
  const { width: termWidth } = useTerminalDimensions();
  const cardRef = useRef<BoxRenderable>(null);
  const followTail = useRef(true);
  const offsetRef = useRef(0);
  const dragActive = useRef(false);
  const dragTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const lineCountRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [requestedOffset, setRequestedOffset] = useState(0);
  const [headingHovered, setHeadingHovered] = useState(false);
  const bodyWidth = Math.max(
    18,
    (contentWidth != null ? contentWidth : Math.max(40, termWidth - 8)) - 4,
  );
  const content = useMemo(
    () => sanitizeDisplayText(item.content).replace(/\r\n/g, "\n"),
    [item.content],
  );
  const liveWrap = useMemo(() => createLiveThinkingWrap(bodyWidth), [bodyWidth]);
  const lines = useMemo(
    () =>
      item.streaming
        ? liveWrap(content)
        : wrapThinkingBody(content, bodyWidth, false),
    [content, bodyWidth, item.streaming, liveWrap],
  );
  const viewport = resolveThinkingViewport({
    lineCount: lines.length,
    offset: item.streaming && followTail.current
      ? Number.POSITIVE_INFINITY
      : requestedOffset,
    maxRows: THINKING_BODY_MAX_ROWS,
  });
  const visibleRows = useMemo(
    () =>
      lines
        .slice(viewport.offset, viewport.offset + viewport.rows)
        .map((row) => row + " ".repeat(Math.max(0, bodyWidth - renderColumns(row)))),
    [lines, viewport.offset, viewport.rows, bodyWidth],
  );
  offsetRef.current = viewport.offset;
  lineCountRef.current = lines.length;

  useEffect(() => {
    if (!item.streaming) return;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(clock);
  }, [item.streaming]);

  useEffect(() => {
    if (item.streaming) return;
    followTail.current = true;
    offsetRef.current = 0;
    setRequestedOffset(0);
  }, [item.streaming]);

  const stopDragScroll = (): void => {
    if (dragTimer.current === undefined) return;
    clearInterval(dragTimer.current);
    dragTimer.current = undefined;
  };

  useEffect(() => stopDragScroll, []);

  const maxOffsetNow = (): number => {
    const rows = Math.max(
      1,
      Math.min(THINKING_BODY_MAX_ROWS, lineCountRef.current),
    );
    return Math.max(0, lineCountRef.current - rows);
  };

  const stepBody = (rows: number): boolean => {
    const maxOffset = maxOffsetNow();
    const next = Math.max(0, Math.min(maxOffset, offsetRef.current + rows));
    if (next === offsetRef.current) return false;
    offsetRef.current = next;
    followTail.current = item.streaming && next >= maxOffset;
    setRequestedOffset(next);
    return true;
  };

  const startDragScroll = (rows: number): void => {
    stopDragScroll();
    dragTimer.current = setInterval(() => {
      if (!dragActive.current || !stepBody(rows)) stopDragScroll();
    }, DRAG_SCROLL_MS);
  };

  const presentation = resolveThinkingPresentation({
    streaming: item.streaming,
    expanded,
    elapsed: thinkingElapsedLabel(item, now),
    content,
  });
  const click = useClickWithoutDrag(onToggle);
  const headingStyle = resolveThinkingHeadingStyle({
    hovered: headingHovered,
    accent: theme.thinking,
    hover: theme.white,
  });
  const headingAttributes = headingStyle.underline
    ? TextAttributes.BOLD | TextAttributes.UNDERLINE
    : TextAttributes.BOLD;

  const onBodyScroll = (event: MouseEvent): void => {
    if (!event.scroll) return;
    const rows = Math.max(1, Math.min(THINKING_BODY_MAX_ROWS, lines.length));
    const maxOffset = Math.max(0, lines.length - rows);
    if (!focused || maxOffset === 0) return;
    event.stopPropagation();
    const base =
      item.streaming && followTail.current ? maxOffset : offsetRef.current;
    const delta = event.scroll.direction === "up" ? -WHEEL_ROWS : WHEEL_ROWS;
    const next = Math.max(0, Math.min(maxOffset, base + delta));
    if (next === base) return;
    offsetRef.current = next;
    followTail.current = item.streaming && next >= maxOffset;
    setRequestedOffset(next);
  };

  const isCardTitleEvent = (event: MouseEvent): boolean => {
    const card = cardRef.current;
    const title = presentation.borderTitle;
    if (!card || !title || event.y !== card.screenY) return false;
    const start = card.screenX + 1;
    const end = Math.min(
      card.screenX + card.width - 1,
      start + renderColumns(title),
    );
    return event.x >= start && event.x < end;
  };

  const onCardTitleMouseDown = (event: MouseEvent): void => {
    if (isCardTitleEvent(event)) {
      click.onMouseDown(event);
      return;
    }
    if (event.button === 0) {
      if (!focused) onFocus?.();
      dragActive.current = true;
      event.preventDefault();
    }
  };

  const onCardTitleMouseUp = (event: MouseEvent): void => {
    endBodyDrag();
    if (isCardTitleEvent(event)) click.onMouseUp(event);
  };

  const onCardTitleMouseMove = (event: MouseEvent): void => {
    if (dragActive.current) {
      dragActive.current = false;
      stopDragScroll();
    }
    const hovered = isCardTitleEvent(event);
    if (hovered !== headingHovered) setHeadingHovered(hovered);
  };

  const isInsideCard = (event: MouseEvent): boolean => {
    const card = cardRef.current;
    if (!card) return false;
    return (
      event.x >= card.screenX &&
      event.x < card.screenX + card.width &&
      event.y >= card.screenY &&
      event.y < card.screenY + card.height
    );
  };

  const onCardMouseOut = (event: MouseEvent): void => {
    setHeadingHovered(false);
    if (dragActive.current) return;
    if (focused && !isInsideCard(event)) onBlur?.();
  };

  const endBodyDrag = (): void => {
    dragActive.current = false;
    stopDragScroll();
  };

  const onBodyDrag = (event: MouseEvent): void => {
    if (!dragActive.current) return;
    const card = cardRef.current;
    if (!card) return;
    const firstBodyRow = card.screenY + 1;
    const lastBodyRow = card.screenY + card.height - 2;
    const maxOffset = maxOffsetNow();
    const up = event.y <= firstBodyRow;
    const down = event.y >= lastBodyRow;
    const canScrollUp = up && offsetRef.current > 0;
    const canScrollDown = down && offsetRef.current < maxOffset;
    if (!canScrollUp && !canScrollDown) {
      stopDragScroll();
      if (up || down) endBodyDrag();
      return;
    }
    event.stopPropagation();
    const rows = canScrollUp ? -DRAG_SCROLL_ROWS : DRAG_SCROLL_ROWS;
    stepBody(rows);
    startDragScroll(rows);
  };

  if (presentation.layout === "line") {
    return (
      <box
        id={item.id}
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          marginBottom: 1,
        }}
        onMouseDown={click.onMouseDown}
        onMouseUp={click.onMouseUp}
        onMouseOver={() => setHeadingHovered(true)}
        onMouseOut={() => setHeadingHovered(false)}
      >
        <text
          content={presentation.heading}
          selectable
          wrapMode="none"
          style={{
            width: "100%",
            height: 1,
            fg: headingStyle.fg,
            attributes: headingAttributes,
          }}
        />
      </box>
    );
  }

  const bodyRows = visibleRows.length > 0 ? visibleRows : ["Waiting for reasoning…"];
  const scrollHint = resolveThinkingFooter({
    focused,
    hiddenAbove: viewport.hiddenAbove,
    hiddenBelow: viewport.hiddenBelow,
  });

  return (
    <box
      ref={cardRef}
      id={item.id}
      border
      borderStyle="rounded"
      title={presentation.borderTitle}
      titleAlignment="left"
      titleColor={focused ? headingStyle.fg : theme.muted}
      {...(scrollHint
        ? { bottomTitle: scrollHint, bottomTitleAlignment: "right" as const }
        : {})}
      onMouseDown={onCardTitleMouseDown}
      onMouseUp={onCardTitleMouseUp}
      onMouseMove={onCardTitleMouseMove}
      onMouseDrag={onBodyDrag}
      onMouseDragEnd={endBodyDrag}
      onMouseOut={onCardMouseOut}
      onMouseScroll={onBodyScroll}
      style={{
        flexDirection: "column",
        width: "100%",
        height: bodyRows.length + 2,
        marginBottom: 1,
        borderColor: focused ? theme.thinking : theme.muted,
        backgroundColor: theme.thinkingBg,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        overflow: "hidden",
      }}
    >
      {bodyRows.map((row, index) => (
        <text
          key={index}
          content={row}
          selectable
          wrapMode="none"
          style={{
            width: bodyWidth,
            height: 1,
            flexShrink: 0,
            fg: focused ? theme.thinking : theme.thinkingDim,
            bg: theme.thinkingBg,
            attributes: TextAttributes.ITALIC,
          }}
        />
      ))}
    </box>
  );
}
