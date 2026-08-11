import { Box, Text } from "ink";
import type { ReactNode } from "react";
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
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: Math.max(0, Math.floor(props.offsetTop)) }, (_, index) => (
        <Text key={`gutter-pad-${index}`}> </Text>
      ))}
      {geometry.map((thumb, index) => (
        <Text key={`gutter-cell-${index}`} wrap="truncate">
          {thumb ? props.ink.fg("muted", scrollbarCell(true)) : props.ink.dim(scrollbarCell(false))}
        </Text>
      ))}
    </Box>
  );
}