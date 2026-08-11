import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { TranscriptWindow } from "./transcript-window.js";

export function LiveTail(props: {
  readonly window: TranscriptWindow;
  readonly rows: number;
}): ReactNode {
  const filler = Math.max(0, props.rows - props.window.height);
  return (
    <Box flexDirection="column" height={props.rows} flexShrink={0}>
      {props.window.rows.map((row) => (
        <Text key={row.key} wrap="truncate">
          {row.line === "" ? " " : row.line}
        </Text>
      ))}
      {Array.from({ length: filler }, (_, index) => (
        <Text key={`live-filler-${index}`} wrap="truncate">
          {" "}
        </Text>
      ))}
    </Box>
  );
}