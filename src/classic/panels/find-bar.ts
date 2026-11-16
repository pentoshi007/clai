import { matchCounterLabel } from "../../ui-core/state/text-search.js";
import type { TranscriptFindSnapshot } from "../feed/transcript-find.js";
import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";

export const FIND_BAR_ROWS = 3;

export interface FindBarInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly find: TranscriptFindSnapshot;
  readonly matchCount: number;
  readonly activeIndex: number;
}

function queryRow(input: FindBarInput, width: number): string {
  const { ink, find } = input;
  const label = ink.style(`${ink.glyphs.promptMark} `, { fg: "inputBorder", bold: true });
  const caret = find.editing ? ink.fg("inputBorder", ink.glyphs.caret) : "";
  const budget = Math.max(1, width - layoutWidth(label) - layoutWidth(caret));
  const query = find.query.length === 0 && find.editing
    ? ink.fg("muted", clipToWidth("type to search the transcript", budget, ink.glyphs.ellipsis))
    : ink.style(clipToWidth(find.query, budget, ink.glyphs.ellipsis), { fg: "foreground", bold: !find.editing });
  return sealStyle(padToWidth(`${label}${query}${caret}`, width));
}

export function findBarView(input: FindBarInput): PanelFrameInput {
  const { ink, find } = input;
  const width = panelBodyWidth(input.columns);
  const counter = matchCounterLabel(find.query, input.matchCount, input.activeIndex);
  const arrows = `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown}`;
  const hints = find.editing
    ? [`${arrows} prev/next`, "^R prev", `${ink.glyphs.enter} done`, "esc clear"]
    : ["n next", "N prev", "^R edit", "esc clear"];
  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Find in transcript",
    counter: counter === "" ? undefined : counter,
    hints,
    borderColor: input.matchCount === 0 && counter !== "" ? "muted" : "inputBorder",
    body: [queryRow(input, width)],
  };
}
