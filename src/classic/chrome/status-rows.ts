import type { ContextUsageSnapshot } from "../../llm/token-usage.js";
import type { Mode } from "../../types.js";
import {
  contextChipForDensity,
  contextUsageSeverity,
  type StatusDensity,
} from "../../ui-core/rendering/context-limit.js";
import {
  armedCancelHint,
  busyCancelHint,
  formatActivity,
  idleHintIds,
  modeIndicatorPresentation,
  spinnerFrame,
  statusDensityForWidth,
  tasksToggleLabel,
  type IdleHintId,
} from "../../ui-core/rendering/status-segments.js";
import { contextLimitEditorLabel, type ContextLimitEditorState } from "./context-limit-editor.js";
import { alignEnds, clipToWidth } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import type { StatusRowsWanted } from "./row-budget.js";

const HINT_LABELS: Readonly<Record<IdleHintId, string>> = {
  commands: "/ commands",
  "cut-draft": "^X cut",
  thinking: "^T thinking",
  output: "^O output",
  shortcuts: "/shortcuts",
};

const CONTEXT_TOKEN: Readonly<Record<"normal" | "warn" | "critical", ThemeToken>> = {
  normal: "muted",
  warn: "activity",
  critical: "diffDel",
};

export const STATUS_INSET_COLUMNS = 1;

export interface StatusViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly allocatedRows: number;
  readonly mode: Mode;
  readonly contextChip: string | undefined;
  readonly contextUsage: ContextUsageSnapshot | undefined;
  readonly contextLimitEditing?: boolean | undefined;
  readonly contextLimitDraft?: string | undefined;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly activity: string | undefined;
  readonly elapsedSeconds: number;
  readonly cancelArmed: boolean;
  readonly tick: number;
  readonly hasDraft: boolean;
  readonly queued: number;
  readonly planVisible: boolean;
  readonly hasActivePlan: boolean;
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export function relativizeHome(path: string, home: string): string {
  if (home.length === 0 || !path.startsWith(home)) return path;
  const tail = path.slice(home.length);
  return tail.length === 0 ? "~" : `~${tail}`;
}

function contextSegment(input: StatusViewInput, density: StatusDensity): string | undefined {
  if (input.contextLimitEditing === true) {
    const state: ContextLimitEditorState = {
      editing: true,
      draft: input.contextLimitDraft ?? "",
    };
    return contextLimitEditorLabel(input.ink, state, Math.max(1, input.columns));
  }
  const baseChip = contextChipForDensity(input.contextUsage, density);
  if (baseChip === undefined) return undefined;
  const token = CONTEXT_TOKEN[contextUsageSeverity(input.contextUsage)];
  const chip =
    density === "xs" || density === "sm"
      ? baseChip.replace(/^ctx\s*/, "").replace(/\/.*$/, "")
      : baseChip;
  return input.ink.fg(token, chip);
}

/** Mode chip plate per mode — opentui ModeChip parity. */
const MODE_PLATE: Readonly<Record<Mode, ThemeToken>> = {
  agent: "chipTeal",
  ask: "chipIndigo",
  plan: "mode",
};

function modeBadge(input: StatusViewInput): string {
  return input.ink.plate(
    MODE_PLATE[input.mode],
    ` ${modeIndicatorPresentation(input.mode).label} `,
  );
}

function separator(input: StatusViewInput): string {
  return input.ink.fg("muted", ` ${input.ink.glyphs.separator} `);
}

/**
 * Priority-ordered prefix fit: segments join with `separator` and the tail
 * segments that would overflow the budget are dropped whole, so a row never
 * ends in a ragged mid-word ellipsis at ordinary widths.
 */
export function fitSegments(
  segments: readonly string[],
  budget: number,
  separator: string,
): string {
  let out = "";
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const candidate = out === "" ? segment : `${out}${separator}${segment}`;
    if (layoutWidth(candidate) > budget) break;
    out = candidate;
  }
  return out;
}

function idleSegments(input: StatusViewInput, density: StatusDensity): string[] {
  const { ink } = input;
  const hints = idleHintIds(density, input.hasDraft).map((id) => HINT_LABELS[id]);
  if (input.hasActivePlan || input.planVisible) {
    hints.push(`^H ${tasksToggleLabel(input.planVisible, density).toLowerCase()}`);
  }
  hints.push(`${ink.unicode ? "⇧⇥" : "S-tab"} mode`);
  if (input.contextUsage !== undefined && density !== "xs" && density !== "sm") {
    hints.push("^L ctx");
  }
  const queued =
    input.queued > 0 ? (density === "sm" ? `${input.queued}q` : `${input.queued} queued`) : "";
  return [...hints.map((hint) => ink.fg("muted", hint)), ink.fg("mode", queued)];
}

function busySegments(input: StatusViewInput, density: StatusDensity, leftBudget: number): string[] {
  const { ink } = input;
  const budget =
    density === "sm" ? Math.max(8, leftBudget - 34) : Math.max(12, leftBudget - 46);
  const label = input.compacting ? "compacting" : formatActivity(input.activity, budget);
  const cancel = input.cancelArmed ? armedCancelHint() : busyCancelHint(density).short;

  return [
    `${ink.fg("spinner", spinnerFrame(input.tick, ink.unicode))} ${ink.fg("activity", label)}`,
    ink.fg(input.cancelArmed ? "activity" : "muted", cancel),
    density === "xs"
      ? ""
      : ink.style(formatElapsed(input.elapsedSeconds), { fg: "accent", bold: true }),
    input.queued > 0 ? ink.fg("mode", `${input.queued}q`) : "",
  ];
}

export function statusRowsWanted(): StatusRowsWanted {
  return 1;
}

/**
 * One straight row under the composer: mode badge + hints (or activity while
 * busy) on the left, context usage flush right — the opentui status-line
 * arrangement, inset one column on each side so no glyph ever touches the
 * composer box's border columns. Scroll position lives on the right-edge
 * scrollbar now, not in this row.
 */
export function statusRows(input: StatusViewInput): readonly string[] {
  const density = statusDensityForWidth(input.columns);
  const inset = STATUS_INSET_COLUMNS;
  const outer = Math.max(1, Math.floor(input.columns));
  const width = Math.max(1, outer - inset * 2);
  if (input.contextLimitEditing === true) {
    const editor = contextLimitEditorLabel(
      input.ink,
      { editing: true, draft: input.contextLimitDraft ?? "" },
      Math.max(1, width - 1),
    );
    return [` ${clipToWidth(editor, Math.max(1, width - 1), input.ink.glyphs.ellipsis)} `];
  }

  const busy = input.running || input.compacting;
  const right = contextSegment(input, density) ?? "";

  if (density === "xs") {
    return [` ${alignEnds(modeBadge(input), right, width, input.ink.glyphs.ellipsis)} `];
  }

  const sep = separator(input);
  const leftBudget = Math.max(1, width - (right === "" ? 0 : layoutWidth(right) + 1));
  const rest = busy
    ? busySegments(input, density, Math.max(1, leftBudget - layoutWidth(modeBadge(input)) - layoutWidth(sep)))
    : idleSegments(input, density);
  const left = fitSegments([modeBadge(input), ...rest], leftBudget, sep);
  const aligned =
    left === "" && right === ""
      ? ""
      : alignEnds(left, right, width, input.ink.glyphs.ellipsis);
  return [` ${aligned} `];
}
