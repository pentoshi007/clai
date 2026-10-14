import { Box, Text } from "ink";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { InkTheme } from "../render/ink-theme.js";
import { scrollbarCell, scrollbarGeometry } from "./scrollbar-rows.js";
import type { TranscriptWindow } from "./transcript-window.js";

export const ScrollbarGutter = memo(function ScrollbarGutter(props: {
  readonly ink: InkTheme;
  readonly window: TranscriptWindow;
  readonly rows: number;
  readonly offsetTop: number;
}): ReactNode {
  const scrollable = props.window.totalRows > props.rows;
  const geometry = scrollable
    ? scrollbarGeometry(props.rows, props.window.totalRows, props.window.offset)
    : [];

  const [isScrolling, setIsScrolling] = useState(false);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevOffsetRef = useRef(props.window.offset);

  useEffect(() => {
    if (props.window.offset !== prevOffsetRef.current) {
      prevOffsetRef.current = props.window.offset;
      if (props.window.offset !== 0) {
        setIsScrolling(true);
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1000);
      } else {
        setIsScrolling(false);
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      }
    }
  }, [props.window.offset]);

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const shouldShow = scrollable && isScrolling && geometry.length > 0;
  const lines = Array.from({ length: Math.max(0, Math.floor(props.offsetTop)) }, () => " ");
  if (shouldShow) {
    const thumb = props.ink.fg("muted", scrollbarCell(true));
    const track = props.ink.fg("border", scrollbarCell(false));
    for (const cell of geometry) lines.push(cell ? thumb : track);
  }
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {lines.length > 0 ? <Text wrap="truncate">{lines.join("\n")}</Text> : null}
    </Box>
  );
});