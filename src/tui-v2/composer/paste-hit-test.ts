import { pastePlaceholderRanges, type PastePlaceholderEntry } from "../../ui-core/composer/paste-placeholder.js";

export interface PasteHitEditor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly plainText: string;
  readonly editorView: {
    getViewport(): { readonly offsetY: number; readonly offsetX: number };
    getLineInfo(): {
      readonly lineSources: readonly number[];
      readonly lineStartCols: readonly number[];
      readonly lineWidthCols: readonly number[];
    };
    getLogicalLineInfo(): {
      readonly lineStartCols: readonly number[];
      readonly lineSources: readonly number[];
    };
  };
  readonly editBuffer: {
    positionToOffset(row: number, col: number): number;
    getTextRange(start: number, end: number): string;
  };
}

export function pasteAtPoint(
  editor: PasteHitEditor | null,
  entries: readonly PastePlaceholderEntry[],
  x: number,
  y: number,
): PastePlaceholderEntry | undefined {
  if (!editor || entries.length === 0) return undefined;
  const localX = x - editor.x;
  const localY = y - editor.y;
  if (localX < 0 || localY < 0 || localX >= editor.width || localY >= editor.height) return undefined;
  const viewport = editor.editorView.getViewport();
  const lines = editor.editorView.getLineInfo();
  const index = localY;
  const row = lines.lineSources[index];
  const startCol = lines.lineStartCols[index];
  const width = lines.lineWidthCols[index];
  if (row === undefined || startCol === undefined || width === undefined || localX >= width) return undefined;
  const allLines = editor.editorView.getLogicalLineInfo();
  const logicalStart = allLines.lineStartCols[allLines.lineSources.indexOf(row)];
  if (logicalStart === undefined) return undefined;
  const offset = editor.editBuffer.positionToOffset(
    row,
    startCol - logicalStart + viewport.offsetX + localX,
  );
  const charOffset = editor.editBuffer.getTextRange(0, offset).length;
  return pastePlaceholderRanges(editor.plainText, entries).find(
    (range) => charOffset >= range.start && charOffset < range.end,
  )?.entry;
}
