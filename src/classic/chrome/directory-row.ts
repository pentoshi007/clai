import { homedir } from "node:os";
import { clipToWidth, middleClipPlain, padToWidth } from "../render/ansi-text.js";
import { jumpToLatestLabel } from "../../ui-core/rendering/jump-to-latest.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme } from "../render/ink-theme.js";
import { insetRow, relativizeHome, STATUS_INSET_COLUMNS } from "./status-rows.js";
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
    return insetRow(input.ink.fg("muted", middleClipPlain(path, width, input.ink.glyphs.ellipsis)));
  }
  const branchBudget = Math.min(layoutWidth(branchText), Math.max(0, width - 2));
  const pathBudget = Math.max(1, width - branchBudget - 2);
  const shownPath = middleClipPlain(path, pathBudget, input.ink.glyphs.ellipsis);
  const branch = clipToWidth(branchText, branchBudget, "");
  return insetRow(`${input.ink.fg("muted", shownPath)}  ${input.ink.fg("userBorder", branch)}`);
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
  return clipToWidth(insetRow(shown), columns, input.ink.glyphs.ellipsis);
}

export function composerDirectoryView(input: ComposerDirectoryViewInput & {
  readonly showJumpToLatest: boolean;
}): { readonly line: string; readonly jump: { readonly left: number; readonly width: number } | undefined } {
  if (!input.showJumpToLatest) return { line: composerDirectoryRow(input), jump: undefined };
  const columns = Math.max(1, Math.floor(input.columns));
  const label = jumpToLatestLabel(Math.min(columns, Math.max(3, Math.floor(columns / 3))), input.ink.unicode);
  if (!label) return { line: composerDirectoryRow(input), jump: undefined };
  const width = layoutWidth(label);
  const trailing = columns > width ? STATUS_INSET_COLUMNS : 0;
  const left = columns - width - trailing;
  const prefixWidth = Math.max(0, left - 1);
  const prefix = clipToWidth(composerDirectoryRow({ ...input, columns: prefixWidth }), prefixWidth, "");
  return {
    line: padToWidth(prefix, left) + input.ink.style(label, { fg: "inputBorder", bold: true }) + " ".repeat(trailing),
    jump: { left, width },
  };
}
