
export interface CursorLineInfo {
  readonly line: number;
  readonly lineCount: number;
}

export function shouldNavigateHistoryUp(info: CursorLineInfo): boolean {
  return info.line <= 0;
}

export function shouldNavigateHistoryDown(info: CursorLineInfo): boolean {
  return info.line >= info.lineCount - 1;
}
