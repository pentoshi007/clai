import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { panelFrameRows, type PanelFrameInput } from "./panel-frame.js";

export function PanelFrame(props: PanelFrameInput): ReactNode {
  const { rows } = panelFrameRows(props);
  return (
    <Box flexDirection="column" height={props.rows} flexShrink={0}>
      {rows.map((row, index) => (
        <Text key={`panel-${index}`} wrap="wrap">
          {row}
        </Text>
      ))}
    </Box>
  );
}
