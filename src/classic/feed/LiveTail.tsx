import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { TranscriptWindow } from "./transcript-window.js";
import type { SelectionState } from "../../ui-core/controllers/selection-controller.js";
import type { SemanticDocument } from "../../ui-core/state/semantic-document.js";
import { selectionSpanForRow } from "./transcript-selection.js";

export function LiveTail(props: {
  readonly window: TranscriptWindow;
  readonly rows: number;
  readonly document?: SemanticDocument | undefined;
  readonly selection?: SelectionState | undefined;
}): ReactNode {
  const filler = Math.max(0, props.rows - props.window.height);
  return (
    <Box flexDirection="column" height={props.rows} flexShrink={0}>
      {props.window.rows.map((row) => {
        const span = props.document && props.selection
          ? selectionSpanForRow(row, props.document, props.selection)
          : undefined;
        const plain = span?.text ?? (row.line === "" ? " " : row.line);
        if (!span) {
          return <Text key={row.key} wrap="truncate">{plain}</Text>;
        }
        const prefix = plain.slice(0, span.start);
        const selected = plain.slice(span.start, span.end);
        const suffix = plain.slice(span.end);
        return (
          <Text key={row.key} wrap="truncate">
            {prefix}<Text inverse>{selected}</Text>{suffix}
          </Text>
        );
      })}
      {Array.from({ length: filler }, (_, index) => (
        <Text key={`live-filler-${index}`} wrap="truncate">
          {" "}
        </Text>
      ))}
    </Box>
  );
}