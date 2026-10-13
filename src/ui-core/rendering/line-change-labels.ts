import { sumLineChanges, type LineChangeTotals } from "../../app/controllers/session-changes.js";
import { stripAnsiSequences } from "./sanitize-display.js";

export function lineChangeLabels(changes: LineChangeTotals | undefined): { added: string; removed: string } | undefined {
  if (!changes || !sumLineChanges([changes])) return undefined;
  return { added: `+${changes.added}`, removed: `-${changes.removed}` };
}

export function paintLineChangeCounts(
  text: string,
  added: (value: string) => string,
  removed: (value: string) => string,
): string {
  const match = /^\s*(?:Total\s*·\s*)?(\+\d+)[ \t]+(-\d+)/.exec(stripAnsiSequences(text));
  return match ? text.replace(match[1]!, added(match[1]!)).replace(match[2]!, removed(match[2]!)) : text;
}
