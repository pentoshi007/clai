import type { ContextUsageSnapshot } from "../../llm/token-usage.js";
import type { Mode } from "../../types.js";
import type { StatusDensity } from "../../ui-core/rendering/context-limit.js";
import type { GenerationMetrics } from "../../llm/generation-metrics.js";
import { footerMetrics } from "../../ui-core/rendering/footer-metrics.js";
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
import { contextLimitEditorLabel } from "./context-limit-editor.js";
import { alignEnds, clipToWidth } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import type { StatusRowsWanted } from "./row-budget.js";

const HINT_LABELS: Readonly<Record<IdleHintId, string>> = {
  commands: "/ commands",
  "cut-draft": "^X cut",
  "clear-draft": "^Q clear",
  thinking: "^T thinking",
  output: "^O output",
};


export const STATUS_INSET_COLUMNS = 0;
const STATUS_RIGHT_INSET_COLUMNS = STATUS_INSET_COLUMNS + 1;

export function insetRow(text: string): string {
  const pad = " ".repeat(STATUS_INSET_COLUMNS);
  return `${pad}${text}${pad}`;
}

export interface StatusViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly allocatedRows: number;
  readonly mode: Mode;
  readonly contextChip: string | undefined;
  readonly contextUsage: ContextUsageSnapshot | undefined;
  readonly generation?: GenerationMetrics | undefined;
  readonly contextLimitEditing?: boolean | undefined;
  readonly contextLimitDraft?: string | undefined;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly activity: string | undefined;
  readonly cancelArmed: boolean;
  readonly tick: number;
  readonly hasDraft: boolean;
  readonly queued: number;
  readonly queueVisible?: boolean | undefined;
  readonly planVisible: boolean;
  readonly hasActivePlan: boolean;
  readonly thinkingExpanded?: boolean | undefined;
  readonly outputExpanded?: boolean | undefined;
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

function metricSegments(input: StatusViewInput): { readonly context: string; readonly rate: string } {
  const usage: ContextUsageSnapshot = input.contextUsage ?? {
    contextTokens: 0,
    contextLimit: 0,
    lastCompletionTokens: 0,
    sessionPromptTokens: 0,
    sessionCompletionTokens: 0,
    exact: true,
  };
  const metrics = footerMetrics(usage, input.generation, input.columns);
  return {
    context: metrics.context ? input.ink.fg("userBorder", metrics.context) : "",
    rate: metrics.rate ? input.ink.fg("muted", metrics.rate) : "",
  };
}

export function contextLimitChipColumns(
  input: StatusViewInput,
): { readonly left: number; readonly width: number } | undefined {
  if (input.contextLimitEditing || input.allocatedRows <= 0) return undefined;
  const columns = Math.max(1, Math.floor(input.columns));
  const contentWidth = Math.max(1, columns - STATUS_INSET_COLUMNS - STATUS_RIGHT_INSET_COLUMNS);
  const width = layoutWidth(metricSegments(input).context);
  if (width === 0 || width + 2 > contentWidth) return undefined;
  return { left: columns - STATUS_RIGHT_INSET_COLUMNS - width, width };
}

const MODE_PLATE: Readonly<Record<Mode, ThemeToken>> = {
  agent: "chipTeal",
  ask: "chipIndigo",
  plan: "mode",
};

function modeBadge(input: StatusViewInput): string {
  const token = MODE_PLATE[input.mode];
  const label = modeIndicatorPresentation(input.mode).label;
  if (input.ink.unicode && input.ink.inkColor(token) !== undefined) {
    return `${input.ink.fg(token, "▐")}${input.ink.plate(token, `${label} `)}`;
  }
  return input.ink.plate(token, ` ${label} `);
}

function separator(input: StatusViewInput): string {
  return input.ink.fg("muted", ` ${input.ink.glyphs.separator} `);
}

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
  const baseHints = idleHintIds(density, input.hasDraft).map((id) => HINT_LABELS[id]);
  const hints: Array<{ label: string; token: ThemeToken }> = [];
  hints.push(
    ...baseHints.map((label) => {
      let token: ThemeToken = "muted";
      if (label === HINT_LABELS.thinking && input.thinkingExpanded) token = "inputBorder";
      else if (label === HINT_LABELS.output && input.outputExpanded) token = "inputBorder";
      return { label, token };
    }),
  );
  if (density !== "xs") {
    const thinkingIdx = hints.findIndex((h) => h.label === HINT_LABELS.thinking);
    const entry = { label: "^N newline", token: "muted" as ThemeToken };
    if (thinkingIdx >= 0) hints.splice(thinkingIdx, 0, entry);
    else hints.push(entry);
  }
  if (input.hasActivePlan || input.planVisible) {
    const hLabel = `^H ${tasksToggleLabel(input.planVisible, density).toLowerCase()}`;
    const token: ThemeToken = input.planVisible ? "inputBorder" : "muted";
    hints.push({ label: hLabel, token });
  }
  const queued =
    input.queued > 0 ? (density === "sm" ? `${input.queued}q` : `${input.queued} queued`) : "";
  const hidden = queued !== "" && input.queueVisible === false ? " (hidden)" : "";
  hints.push({ label: `${queued}${hidden}`, token: "mode" });
  if (density !== "xs" && density !== "sm") {
    hints.push({ label: "^L limit", token: "muted" });
  }
  return hints.map((h) => ink.fg(h.token, h.label));
}

function busySegments(input: StatusViewInput, density: StatusDensity, leftBudget: number): string[] {
  const { ink } = input;
  const reserve = density === "sm" ? 22 : density === "xs" ? 18 : 30;
  const budget = Math.max(10, leftBudget - reserve);
  const label = input.compacting ? "compacting" : formatActivity(input.activity, budget);
  const cancel = input.cancelArmed ? armedCancelHint() : busyCancelHint(density).short;
  return [
    `${ink.fg("spinner", spinnerFrame(input.tick, ink.unicode))} ${ink.fg("activity", label)}`,
    ink.fg(input.cancelArmed ? "activity" : "muted", cancel),
    input.queued > 0 ? ink.fg("mode", `${input.queued}q${input.queueVisible === false ? " hidden" : ""}`) : "",
  ];
}

export function statusRowsWanted(): StatusRowsWanted {
  return 1;
}

export function statusRows(input: StatusViewInput): readonly string[] {
  const density = statusDensityForWidth(input.columns);
  const inset = STATUS_INSET_COLUMNS;
  const outer = Math.max(1, Math.floor(input.columns));
  const width = Math.max(1, outer - inset - STATUS_RIGHT_INSET_COLUMNS);
  if (input.contextLimitEditing === true) {
    const editor = contextLimitEditorLabel(
      input.ink,
      { editing: true, draft: input.contextLimitDraft ?? "" },
      Math.max(1, width - 1),
    );
    return [insetRow(clipToWidth(editor, Math.max(1, width - 1), input.ink.glyphs.ellipsis))];
  }

  const busy = input.running || input.compacting;
  const metrics = metricSegments(input);
  const right = [metrics.rate, metrics.context].filter(Boolean).join(separator(input));

  if (density === "xs") {
    return [insetRow(alignEnds(modeBadge(input), right, width, input.ink.glyphs.ellipsis))];
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
  return [insetRow(aligned)];
}
