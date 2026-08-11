import type { PlanTask, SessionPlan } from "../../store/plan.js";
import {
  cleanTaskTitle,
  formatPlanPagerDocument,
  orderPlanTasksForDisplay,
  progressBar,
  progressView,
  taskGlyph,
  taskOwnerChip,
  taskStateColor,
  wrapPlanText,
} from "../../ui-core/rendering/plan-view.js";
import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import { adaptPresenterGlyphs } from "../render/glyphs.js";
import type { InkTheme } from "../render/ink-theme.js";
import { listWindow } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export interface PlanPanelState {
  readonly cursor: number;
  readonly top: number;
}

export const PLAN_INITIAL_STATE: PlanPanelState = { cursor: 0, top: 0 };

export function planTasks(plan: SessionPlan): readonly PlanTask[] {
  return orderPlanTasksForDisplay(plan.tasks);
}

export interface PlanKeyInput {
  readonly state: PlanPanelState;
  readonly chord: string;
  readonly plan: SessionPlan;
  readonly rows: number;
  readonly focused: boolean;
}

export function planKey(input: PlanKeyInput): PanelKeyResult<PlanPanelState> {
  const { state, chord } = input;
  if (chord === "ctrl+p") {
    return handled(state, {
      kind: "open-pager",
      title: "Plan",
      body: formatPlanPagerDocument(input.plan),
      markdown: "force",
    });
  }
  if (chord === "ctrl+h") return handled(state, { kind: "plan-hide" });
  if (!input.focused) return unhandled(state);

  const count = planTasks(input.plan).length;
  const height = Math.max(1, panelBodyHeight(input.rows) - 1);
  if (chord === "up" || chord === "down") {
    if (count === 0) return handled(state);
    const cursor = (state.cursor + (chord === "up" ? -1 : 1) + count) % count;
    const window = listWindow({ count, active: cursor, height, previousTop: state.top });
    return handled({ cursor, top: window.top });
  }
  return unhandled(state);
}

export interface PlanViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly plan: SessionPlan;
  readonly state: PlanPanelState;
  readonly focused: boolean;
}

interface PlanRow {
  readonly text: string;
  readonly taskIndex: number;
  readonly owner: boolean;
}

function taskRows(input: PlanViewInput, width: number): readonly PlanRow[] {
  const { ink } = input;
  const rows: PlanRow[] = [];
  planTasks(input.plan).forEach((task, index) => {
    const glyph = adaptPresenterGlyphs(taskGlyph(task), ink.unicode);
    const token = taskStateColor(task.state);
    const wrapped = wrapPlanText(cleanTaskTitle(task), Math.max(8, width - 2));
    wrapped.forEach((line, offset) => {
      const head = offset === 0 ? ink.fg(token, glyph) : " ";
      rows.push({ text: `${head} ${line}`, taskIndex: index, owner: false });
    });
    const owner = taskOwnerChip(task);
    if (owner) {
      rows.push({
        text: `   ${ink.fg("chipTeal", adaptPresenterGlyphs(owner, ink.unicode))}`,
        taskIndex: index,
        owner: true,
      });
    }
  });
  return rows;
}

export function planView(input: PlanViewInput): PanelFrameInput {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const progress = progressView(input.plan);
  const bar = adaptPresenterGlyphs(
    progressBar(progress.done, progress.total, Math.min(12, Math.max(4, width - 8))),
    ink.unicode,
  );
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  const rows = taskRows(input, width);
  const cursorRow = Math.max(
    0,
    rows.findIndex((row) => row.taskIndex === state.cursor && !row.owner),
  );
  const window = listWindow({
    count: rows.length,
    active: cursorRow,
    height: Math.max(1, height - 1),
    previousTop: state.top,
  });

  const body: string[] = [
    sealStyle(
      clipToWidth(
        `${ink.fg("activity", bar)}  ${ink.fg("muted", `${percent}%`)}`,
        width,
        ink.glyphs.ellipsis,
      ),
    ),
  ];

  for (const row of rows.slice(window.top, window.top + window.height)) {
    const active = input.focused && row.taskIndex === state.cursor;
    const text = padToWidth(clipToWidth(row.text, width, ink.glyphs.ellipsis), width);
    body.push(
      active
        ? sealStyle(ink.style(text, { fg: "accent", bold: true }))
        : sealStyle(text),
    );
  }

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Tasks",
    borderColor: "border",
    counter: `${progress.done}/${progress.total} done`,
    hints: [
      "^H hide",
      "^P detail",
      `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown} task`,
    ],
    body: body.slice(0, Math.max(0, height)),
  };
}
