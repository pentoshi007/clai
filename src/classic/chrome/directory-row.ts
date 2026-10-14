import { homedir } from "node:os";
import { clipToWidth, middleClipPlain } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme } from "../render/ink-theme.js";
import { relativizeHome, STATUS_INSET_COLUMNS } from "./status-rows.js";
import { queueStatusLabel } from "./queue-rows.js";

interface DirectoryViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly cwd: string;
  readonly branch: string | undefined;
}

export function directoryRow(input: DirectoryViewInput): string {
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

interface ComposerDirectoryViewInput extends DirectoryViewInput {
  readonly hasActivePlan: boolean;
  readonly planVisible: boolean;
  readonly queued: number;
  readonly queueVisible: boolean;
}

function contextHints(input: ComposerDirectoryViewInput, compact: boolean): string {
  const { ink } = input;
  const queued = queueStatusLabel(input.queued, input.queueVisible, compact);
  let tasks = "";
  if (input.hasActivePlan && (!input.planVisible || queued !== "")) {
    const action = input.planVisible ? "hide" : "expand";
    const label = compact ? "^H tasks" : `Tasks active . cntrl+H to ${action}`;
    tasks = ink.fg("inputBorder", label);
  }
  const queue = ink.fg(input.queueVisible ? "activity" : "muted", queued);
  return [tasks, queue].filter((hint) => hint !== "").join(ink.fg("muted", ` ${ink.glyphs.separator} `));
}

export function composerDirectoryRow(input: ComposerDirectoryViewInput): string {
  const dir = directoryRow(input);
  const full = contextHints(input, false);
  if (full === "") return dir;
  const columns = Math.max(1, Math.floor(input.columns));
  const width = Math.max(0, columns - STATUS_INSET_COLUMNS * 2);
  const hasQueueHint = input.queued > 0 || !input.queueVisible;
  const hints = hasQueueHint && layoutWidth(full) > width ? contextHints(input, true) : full;
  const line = `${dir.trim()}   ${hints}`;
  const shown = layoutWidth(line) <= width ? line : clipToWidth(hints, width, input.ink.glyphs.ellipsis);
  return clipToWidth(` ${shown} `, columns, input.ink.glyphs.ellipsis);
}
