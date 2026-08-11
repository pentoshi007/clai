/**
 * Up/Down disambiguation for a multiline composer (INPUT-006, V2-043).
 *
 * Inside a multiline value, Up/Down move the cursor between visual lines by
 * default. History navigation only takes over once the cursor is already at
 * the boundary it would otherwise move past — the top line for Up, the
 * bottom line for Down — so history recall never steals a cursor move the
 * user is mid-way through.
 */

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
