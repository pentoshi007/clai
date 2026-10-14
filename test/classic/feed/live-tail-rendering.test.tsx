import { Box, Text, renderToString } from "ink";
import { render } from "ink-testing-library";
import { type ComponentProps, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { LiveTail } from "../../../src/classic/feed/LiveTail.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { classicTranscriptDocument, selectionSpanForRow } from "../../../src/classic/feed/transcript-selection.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import type { SelectionState } from "../../../src/ui-core/controllers/selection-controller.js";

type Props = ComponentProps<typeof LiveTail>;

function referenceRows(props: Props): ReactNode {
  const filler = Math.max(0, props.rows - props.window.height);
  return <Box flexDirection="column" height={props.rows} flexShrink={0}>
    {props.window.rows.map((row) => {
      const span = props.document && props.selection
        ? selectionSpanForRow(row, props.document, props.selection)
        : undefined;
      const text = span?.text ?? (row.line === "" ? " " : row.line);
      if (!span) return <Text key={row.key} wrap="truncate">{text}</Text>;
      return <Text key={row.key} wrap="truncate">
        {text.slice(0, span.start)}<Text inverse>{text.slice(span.start, span.end)}</Text>{text.slice(span.end)}
      </Text>;
    })}
    {Array.from({ length: filler }, (_, index) => <Text key={`filler-${index}`} wrap="truncate"> </Text>)}
  </Box>;
}

function blocks(): FeedBlock[] {
  return [
    {
      key: "0:a", itemId: "a", kind: "assistant", open: false,
      lines: ["alpha bravo", "", "\x1b[31m界🙂色\x1b[0m", "a very long line that must not hide the rows after it"],
      turnId: undefined, sequence: 0,
    },
    {
      key: "0:b", itemId: "b", kind: "assistant", open: false,
      lines: ["last row preserved", ""], turnId: undefined, sequence: 1,
    },
  ];
}

describe("LiveTail rendering safeguards", () => {
  it("matches row-by-row rendering for colors, Unicode, gaps, clipping, selection, and filler", () => {
    const feed = blocks();
    const document = classicTranscriptDocument(feed);
    const selection: SelectionState = {
      activePane: "transcript",
      range: {
        pane: "transcript",
        anchor: { blockId: "0:a", offset: 2 },
        focus: { blockId: "0:b", offset: 8 },
      },
      dragging: false,
      autoscrollPane: undefined,
    };
    for (const columns of [3, 8, 20, 80]) {
      for (const rows of [0, 3, 10]) {
        for (const selected of [undefined, selection]) {
          const props: Props = { window: planTranscriptWindow(feed, rows, 0), rows, columns, document, selection: selected };
          const actual = renderToString(<Box width={columns}><LiveTail {...props} /></Box>);
          const expected = renderToString(<Box width={columns}>{referenceRows(props)}</Box>);
          expect(actual, `${columns} columns, ${rows} rows, selected=${selected !== undefined}`).toBe(expected);
        }
      }
    }
  });

  it("does not rebuild unchanged transcript rows for a parent/chrome update", async () => {
    const feed = blocks();
    const window = planTranscriptWindow(feed, 1, 0);
    const readLine = vi.fn(() => "visible row");
    const counted = { ...window, rows: [{ ...window.rows[0]!, get line() { return readLine(); } }] };
    const ui = render(<LiveTail window={counted} rows={1} columns={80} />);
    try {
      expect(readLine).toHaveBeenCalled();
      readLine.mockClear();
      ui.rerender(<LiveTail window={counted} rows={1} columns={80} />);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readLine).not.toHaveBeenCalled();
      ui.rerender(<LiveTail window={{ ...counted }} rows={1} columns={80} />);
      await vi.waitFor(() => expect(readLine).toHaveBeenCalled());
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  });
});
