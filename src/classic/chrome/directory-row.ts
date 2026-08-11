import { homedir } from "node:os";
import { clipToWidth, middleClipPlain } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme } from "../render/ink-theme.js";
import { relativizeHome, STATUS_INSET_COLUMNS } from "./status-rows.js";

/**
 * Working-directory line rendered directly above the composer box, flush to
 * the composer's inner bounds: the home-shortened path in muted plus the git
 * branch grouped together on the left. The path shrinks with a middle
 * ellipsis first so the branch never falls off the edge; the builder's
 * budget is the same inset content column the status row uses.
 */
export function directoryRow(input: {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly cwd: string;
  readonly branch: string | undefined;
}): string {
  const width = Math.max(1, Math.floor(input.columns) - STATUS_INSET_COLUMNS * 2);
  const path = relativizeHome(input.cwd, homedir());
  const icon = input.ink.unicode ? "\ue0a0" : "@";
  const branchText = input.branch === undefined ? "" : `${icon} ${input.branch}`;
  if (branchText === "") {
    return ` ${input.ink.fg("muted", middleClipPlain(path, width, input.ink.glyphs.ellipsis))} `;
  }
  const branchBudget = Math.min(layoutWidth(branchText), Math.max(0, width - 2));
  const pathBudget = Math.max(1, width - branchBudget - 2);
  const shownPath = middleClipPlain(path, pathBudget, input.ink.glyphs.ellipsis);
  const branch = clipToWidth(branchText, branchBudget, "");
  return ` ${input.ink.fg("muted", shownPath)}  ${input.ink.fg("userBorder", branch)} `;
}
