import type { BackgroundJob } from "../../app/ports/jobs-port.js";
import { isLiveJobStatus } from "../../ui-core/rendering/job-tail-source.js";
import { formatJobElapsed } from "../../tools/jobs.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { emptyRow, listRow } from "./list-rows.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export interface JobsPanelState {
  readonly cursor: number;
  readonly top: number;
}

export const JOBS_INITIAL_STATE: JobsPanelState = { cursor: 0, top: 0 };

interface JobPresentation {
  readonly glyph: string;
  readonly token: ThemeToken;
  readonly label: string;
}

export function jobPresentation(ink: InkTheme, job: BackgroundJob): JobPresentation {
  const glyphs = ink.glyphs;
  switch (job.status) {
    case "starting":
      return { glyph: glyphs.toolQueued, token: "muted", label: "queued" };
    case "running":
      return { glyph: glyphs.toolRunning, token: "activity", label: "running" };
    case "stopping":
      return { glyph: glyphs.toolRunning, token: "activity", label: "stopping" };
    case "exited":
      return job.exitCode === 0
        ? { glyph: glyphs.toolOk, token: "success", label: "done" }
        : { glyph: glyphs.toolFailed, token: "diffDel", label: "failed" };
    case "failed":
      return { glyph: glyphs.toolFailed, token: "diffDel", label: "failed" };
    case "killed":
      return { glyph: glyphs.toolBlocked, token: "muted", label: "stopped" };
    default:
      return { glyph: glyphs.toolBlocked, token: "muted", label: "lost" };
  }
}

export interface JobsKeyInput {
  readonly state: JobsPanelState;
  readonly chord: string;
  readonly jobs: readonly BackgroundJob[];
  readonly rows: number;
}

export function jobsKey(input: JobsKeyInput): PanelKeyResult<JobsPanelState> {
  const { state, chord } = input;
  const count = input.jobs.length;
  const height = Math.max(1, panelBodyHeight(input.rows));
  const selected = input.jobs[Math.min(state.cursor, Math.max(0, count - 1))];

  const move = (delta: number): PanelKeyResult<JobsPanelState> => {
    if (count === 0) return handled(state);
    const cursor = (state.cursor + delta + count) % count;
    const window = listWindow({ count, active: cursor, height, previousTop: state.top });
    return handled({ cursor, top: window.top });
  };

  if (chord === "up") return move(-1);
  if (chord === "down") return move(1);
  if (chord === "pageup") return move(-height);
  if (chord === "pagedown") return move(height);
  if (chord === "enter" || chord === "t") {
    return selected
      ? handled(state, { kind: "job-tail", jobId: selected.id })
      : handled(state);
  }
  if (chord === "k") {
    return selected
      ? handled(state, { kind: "job-stop", jobId: selected.id })
      : handled(state);
  }
  if (chord === "q") return handled(state, { kind: "close" });
  return unhandled(state);
}

export interface JobsViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly jobs: readonly BackgroundJob[];
  readonly state: JobsPanelState;
  readonly now: number;
}

export function jobsView(input: JobsViewInput): PanelFrameInput {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const count = input.jobs.length;
  const window = listWindow({
    count,
    active: state.cursor,
    height: Math.max(1, height),
    previousTop: state.top,
  });

  const body: string[] = [];
  if (count === 0) {
    body.push(emptyRow(ink, width, "no background jobs"));
  } else {
    const visible = input.jobs.slice(window.top, window.top + window.height);
    visible.forEach((job, offset) => {
      const index = window.top + offset;
      const presentation = jobPresentation(ink, job);
      const elapsed = isLiveJobStatus(job.status) || job.endedAt
        ? formatJobElapsed(job, input.now)
        : "";
      const right = [presentation.label, elapsed]
        .filter((part) => part !== "")
        .join(` ${ink.glyphs.separator} `);
      body.push(
        listRow({
          ink,
          width,
          columns: input.columns,
          label: `${ink.fg(presentation.token, presentation.glyph)} ${job.commandDisplay}`,
          description: right,
          active: index === state.cursor,
        }),
      );
    });
  }

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Background jobs",
    borderColor: "border",
    counter: windowCounter(state.cursor, count),
    hints: [
      `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown}`,
      `${ink.glyphs.enter} live`,
      "t tail",
      "k stop",
      "q close",
    ],
    body,
  };
}
