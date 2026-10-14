import { Box, Text } from "ink";
import { memo, type ReactNode } from "react";
import type { TranscriptWindow } from "./transcript-window.js";
import type { SelectionState } from "../../ui-core/controllers/selection-controller.js";
import type { SemanticDocument } from "../../ui-core/state/semantic-document.js";
import { selectionSpanForRow } from "./transcript-selection.js";
import { layoutWidth } from "../render/measure.js";

export const LiveTail = memo(function LiveTail(props: {
  readonly window: TranscriptWindow;
  readonly rows: number;
  readonly columns?: number | undefined;
  readonly document?: SemanticDocument | undefined;
  readonly selection?: SelectionState | undefined;
}): ReactNode {
  const filler = Math.max(0, props.rows - props.window.height);
  const lines: ReactNode[] = props.window.rows.map((row) => {
    const span = props.document && props.selection
      ? selectionSpanForRow(row, props.document, props.selection)
      : undefined;
    if (!span) return row.line === "" ? " " : row.line;
    return (
      <Text key={row.key}>
        {span.text.slice(0, span.start)}
        <Text inverse>{span.text.slice(span.start, span.end)}</Text>
        {span.text.slice(span.end)}
      </Text>
    );
  });
  for (let index = 0; index < filler; index += 1) lines.push(" ");
  const content = lines.every((line) => typeof line === "string")
    ? lines.join("\n")
    : lines.flatMap((line, index) => index === 0 ? [line] : ["\n", line]);
  const columns = props.columns;
  const fits = columns !== undefined && props.window.rows.every((row) => layoutWidth(row.line) <= columns);
  let rendered: ReactNode = null;
  if (lines.length > 0) {
    rendered = fits
      ? <Text wrap="truncate">{content}</Text>
      : lines.map((line, index) => (
        <Text key={props.window.rows[index]?.key ?? `live-filler-${index}`} wrap="truncate">{line}</Text>
      ));
  }
  return <Box flexDirection="column" height={props.rows} flexShrink={0}>{rendered}</Box>;
});