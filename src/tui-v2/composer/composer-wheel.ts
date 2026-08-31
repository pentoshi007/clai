
export function composerDraftOverflows(
  contentLines: number,
  visibleRows: number,
): boolean {
  return Math.max(1, contentLines) > Math.max(1, visibleRows);
}

export function composerOwnsWheel(contentLines: number): boolean {
  return Math.max(1, contentLines) > 1;
}

export function nextComposerScrollOffset(opts: {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly totalLines: number;
  readonly direction: "up" | "down" | string;
  readonly delta?: number | undefined;
  readonly lineStep?: number | undefined;
}): number | undefined {
  const height = Math.max(1, opts.viewportHeight);
  const total = Math.max(0, opts.totalLines);
  const maxOffset = Math.max(0, total - height);
  if (maxOffset <= 0) return undefined;
  const step = Math.max(1, opts.delta ?? 1) * Math.max(1, opts.lineStep ?? 3);
  const cur = Math.max(0, Math.min(maxOffset, opts.offsetY));
  if (opts.direction === "up") return Math.max(0, cur - step);
  if (opts.direction === "down") return Math.min(maxOffset, cur + step);
  return undefined;
}

export interface ComposerWheelEditor {
  readonly lineCount?: number;
  readonly virtualLineCount?: number;
  readonly plainText?: string;
  readonly editorView: {
    getViewport(): {
      offsetY: number;
      offsetX: number;
      height: number;
      width: number;
    };
    getTotalVirtualLineCount?: () => number;
    setViewport(
      x: number,
      y: number,
      width: number,
      height: number,
      moveCursor?: boolean,
    ): void;
  };
  moveCursorUp(): unknown;
  moveCursorDown(): unknown;
}

export function measureComposerLines(
  editor: ComposerWheelEditor | null | undefined,
  contentLinesFallback: number,
): number {
  if (!editor) return Math.max(1, contentLinesFallback);
  const fromView =
    editor.editorView.getTotalVirtualLineCount?.() ??
    editor.virtualLineCount ??
    0;
  const logical = editor.lineCount ?? 0;
  const hardBreaks = editor.plainText
    ? Math.max(1, editor.plainText.split("\n").length)
    : 1;
  return Math.max(1, contentLinesFallback, fromView, logical, hardBreaks);
}

export function tryScrollComposerDraft(
  editor: ComposerWheelEditor,
  opts: {
    readonly contentLines: number;
    readonly visibleRows: number;
    readonly direction: "up" | "down" | string;
    readonly delta?: number | undefined;
  },
): boolean {
  const lines = measureComposerLines(editor, opts.contentLines);
  if (!composerOwnsWheel(lines) && !composerDraftOverflows(lines, opts.visibleRows)) {
    return false;
  }

  const steps = Math.max(1, opts.delta ?? 1) * 3;

  if (composerDraftOverflows(lines, opts.visibleRows)) {
    try {
      const view = editor.editorView;
      const vp = view.getViewport();
      const total =
        view.getTotalVirtualLineCount?.() ??
        editor.virtualLineCount ??
        lines;
      const nextY = nextComposerScrollOffset({
        offsetY: vp.offsetY,
        viewportHeight: vp.height || opts.visibleRows,
        totalLines: total,
        direction: opts.direction,
        delta: opts.delta,
      });
      if (nextY !== undefined && nextY !== vp.offsetY) {
        view.setViewport(vp.offsetX, nextY, vp.width, vp.height, false);
        return true;
      }
    } catch {
    }
  }

  if (opts.direction === "up") {
    for (let i = 0; i < steps; i++) editor.moveCursorUp();
    return true;
  }
  if (opts.direction === "down") {
    for (let i = 0; i < steps; i++) editor.moveCursorDown();
    return true;
  }
  return true;
}

export function wheelChatDelta(
  direction: "up" | "down" | string,
  delta?: number,
): number {
  const step = Math.max(1, delta ?? 1) * 3;
  if (direction === "up") return -step;
  if (direction === "down") return step;
  return 0;
}

export function resolveComposerWheelTarget(opts: {
  readonly composerFocused: boolean;
  readonly editor: ComposerWheelEditor | null | undefined;
  readonly contentLines: number;
  readonly visibleRows: number;
}): "draft" | "chat" {
  if (!opts.composerFocused || !opts.editor) return "chat";
  const lines = measureComposerLines(opts.editor, opts.contentLines);
  if (
    composerOwnsWheel(lines) ||
    composerDraftOverflows(lines, opts.visibleRows)
  ) {
    return "draft";
  }
  return "chat";
}
