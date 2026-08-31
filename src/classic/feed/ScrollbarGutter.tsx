import { Box, Text } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InkTheme } from "../render/ink-theme.js";
import { scrollbarCell, scrollbarGeometry } from "./scrollbar-rows.js";
import type { TranscriptWindow } from "./transcript-window.js";

export function ScrollbarGutter(props: {
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
  if (!shouldShow) {
    return (
      <Box flexDirection="column" width={1} flexShrink={0}>
        {Array.from({ length: Math.max(0, Math.floor(props.offsetTop)) }, (_, index) => (
          <Text key={`gutter-pad-${index}`}> </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: Math.max(0, Math.floor(props.offsetTop)) }, (_, index) => (
        <Text key={`gutter-pad-${index}`}> </Text>
      ))}
      {geometry.map((thumb, index) => (
        <Text key={`gutter-cell-${index}`} wrap="truncate">
          {thumb ? props.ink.fg("muted", scrollbarCell(true)) : props.ink.fg("border", scrollbarCell(false))}
        </Text>
      ))}
    </Box>
  );
}