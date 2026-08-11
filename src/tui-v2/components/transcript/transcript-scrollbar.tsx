/** @jsxImportSource @opentui/react */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { Theme } from "../../rendering/theme.js";

export interface ScrollbarMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportHeight: number;
  readonly y: number;
}

function readMetrics(sb: ScrollBoxRenderable | null): ScrollbarMetrics {
  if (!sb) return { scrollTop: 0, scrollHeight: 0, viewportHeight: 0, y: 0 };
  return {
    scrollTop: sb.scrollTop,
    scrollHeight: sb.scrollHeight,
    viewportHeight: sb.viewport?.height ?? 0,
    y: sb.y,
  };
}

export function thumbRange(metrics: ScrollbarMetrics): { top: number; size: number } | null {
  const { scrollTop, scrollHeight, viewportHeight } = metrics;
  if (scrollHeight <= viewportHeight || viewportHeight <= 0) return null;
  const trackSize = viewportHeight;
  const ratio = Math.min(1, viewportHeight / scrollHeight);
  const size = Math.max(2, Math.floor(trackSize * ratio));
  const maxTop = trackSize - size;
  const progress = Math.min(1, scrollTop / Math.max(1, scrollHeight - viewportHeight));
  return { top: Math.round(maxTop * progress), size };
}

export function scrollbarSegments(
  range: { top: number; size: number },
  trackHeight: number,
): { above: number; thumb: number; below: number } {
  const above = Math.max(0, Math.min(range.top, trackHeight));
  const thumb = Math.max(0, Math.min(range.size, trackHeight - above));
  const below = Math.max(0, trackHeight - above - thumb);
  return { above, thumb, below };
}

const TRACK_GLYPH = "▓";
const THUMB_GLYPH = "█";

function glyphRows(glyph: string, rows: number): string {
  return Array<string>(Math.max(0, rows)).fill(glyph).join("\n");
}

export function TranscriptScrollbar(props: {
  readonly scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  readonly theme: Theme;
  readonly followKey: string;
}): ReactNode {
  const { scrollRef, theme, followKey } = props;
  const [metrics, setMetrics] = useState<ScrollbarMetrics>(() =>
    readMetrics(scrollRef.current),
  );
  const [active, setActive] = useState<"idle" | "hover" | "drag">("idle");
  const [isScrolling, setIsScrolling] = useState(false);
  const draggingRef = useRef(false);
  const dragOffset = useRef<number | undefined>(undefined);
  const lastDragUpdate = useRef(0);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevScrollTopRef = useRef<number>(0);

  const triggerVisible = useCallback((): void => {
    setIsScrolling(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1000);
  }, []);

  const refresh = useCallback((): void => {
    const next = readMetrics(scrollRef.current);
    setMetrics((prev) => {
      if (prev.scrollTop !== next.scrollTop) triggerVisible();
      return next;
    });
  }, [scrollRef, triggerVisible]);

  useLayoutEffect(() => {
    refresh();
  }, [refresh, followKey]);

  useEffect(() => {
    const id = setInterval(refresh, 100);
    return () => clearInterval(id);
  }, [refresh, followKey]);

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (metrics.scrollTop !== prevScrollTopRef.current) {
      prevScrollTopRef.current = metrics.scrollTop;
      triggerVisible();
    }
  }, [metrics.scrollTop, triggerVisible]);

  const applyScroll = useCallback(
    (relativeY: number): void => {
      const sb = scrollRef.current;
      if (!sb) return;
      const vh = sb.viewport?.height ?? 0;
      const sh = sb.scrollHeight;
      if (sh <= vh) return;
      const progress = Math.max(0, Math.min(1, relativeY / vh));
      const max = sh - vh;
      sb.scrollTo(Math.round(max * progress));
    },
    [scrollRef],
  );

  const onMouseDown = useCallback(
    (event: MouseEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      triggerVisible();
      const sb = scrollRef.current;
      if (!sb) return;
      const relativeY = event.y - sb.y;
      const r = thumbRange(readMetrics(sb));
      if (r) {
        const thumbCenter = r.top + Math.floor(r.size / 2);
        if (Math.abs(relativeY - thumbCenter) <= Math.ceil(r.size / 2)) {
          dragOffset.current = relativeY - r.top;
          draggingRef.current = true;
          setActive("drag");
          return;
        }
      }
      dragOffset.current = undefined;
      draggingRef.current = true;
      setActive("drag");
      applyScroll(relativeY);
    },
    [scrollRef, applyScroll, triggerVisible],
  );

  const onMouseDrag = useCallback(
    (event: MouseEvent): void => {
      if (!draggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      triggerVisible();
      const sb = scrollRef.current;
      if (!sb) return;
      const relativeY = event.y - sb.y;
      const vh = sb.viewport?.height ?? 0;
      if (dragOffset.current !== undefined) {
        const r = thumbRange(readMetrics(sb));
        const size = r?.size ?? 1;
        const maxTop = vh - size;
        const desiredTop = relativeY - dragOffset.current;
        const clamped = Math.max(0, Math.min(maxTop, desiredTop));
        const progress = maxTop > 0 ? clamped / maxTop : 0;
        const max = sb.scrollHeight - vh;
        sb.scrollTo(Math.round(max * progress));
      } else {
        applyScroll(relativeY);
      }
      const now = Date.now();
      if (now - lastDragUpdate.current > 40) {
        lastDragUpdate.current = now;
        setMetrics(readMetrics(sb));
      }
    },
    [scrollRef, applyScroll, triggerVisible],
  );

  const endDrag = useCallback(
    (event: MouseEvent): void => {
      if (!draggingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = false;
      setActive("idle");
      setMetrics(readMetrics(scrollRef.current));
    },
    [scrollRef],
  );

  const onWheel = useCallback(
    (event: MouseEvent): void => {
      if (!event.scroll) return;
      event.preventDefault();
      event.stopPropagation();
      triggerVisible();
      const sb = scrollRef.current;
      if (!sb) return;
      const { direction, delta } = event.scroll;
      const step = Math.max(1, delta || 1) * 3;
      const dy = direction === "up" ? -step : direction === "down" ? step : 0;
      if (dy === 0) return;
      const max = sb.scrollHeight - (sb.viewport?.height ?? 0);
      sb.scrollTo(Math.max(0, Math.min(max, sb.scrollTop + dy)));
      setMetrics(readMetrics(sb));
    },
    [scrollRef, triggerVisible],
  );

  const range = thumbRange(metrics);
  const trackHeight = metrics.viewportHeight;
  const shouldShow = isScrolling || active !== "idle";
  const visible = range !== null && trackHeight > 0 && shouldShow;
  if (!visible) return null;

  const segments = scrollbarSegments(range, trackHeight);
  const trackColor = active === "idle" ? theme.border : theme.muted;
  const thumbColor = active === "idle" ? theme.muted : theme.cyan;

  return (
    <box
      style={{
        position: "absolute",
        top: metrics.y,
        right: 0,
        width: 1,
        height: trackHeight,
        zIndex: 50,
        flexDirection: "column",
      }}
      onMouseDown={onMouseDown}
      onMouseDrag={onMouseDrag}
      onMouseUp={endDrag}
      onMouseDragEnd={endDrag}
      onMouseOver={() => {
        triggerVisible();
        setActive((current) => (draggingRef.current ? current : "hover"));
      }}
      onMouseOut={() => setActive((current) => (draggingRef.current ? current : "idle"))}
      onMouseScroll={onWheel}
    >
      {segments.above > 0 ? (
        <text
          selectable={false}
          content={glyphRows(TRACK_GLYPH, segments.above)}
          style={{ fg: trackColor }}
        />
      ) : null}
      <text
        selectable={false}
        content={glyphRows(THUMB_GLYPH, segments.thumb)}
        style={{ fg: thumbColor }}
      />
      {segments.below > 0 ? (
        <text
          selectable={false}
          content={glyphRows(TRACK_GLYPH, segments.below)}
          style={{ fg: trackColor }}
        />
      ) : null}
    </box>
  );
}
