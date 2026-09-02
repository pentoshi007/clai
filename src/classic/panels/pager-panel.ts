import { renderMarkdownLines } from "../../ui-core/rendering/render-markdown-lines.js";
import { defaultPagerMarkdownMode } from "../../ui-core/rendering/pager-view-policy.js";
import { extractFsReadFileBody, stripPagerLineGutters } from "../../ui-core/rendering/pager-source.js";
import { wrapPagerLine } from "../../ui-core/rendering/pager-chrome.js";
import {
  findPagerMatches,
  nextPagerMatch,
  prevPagerMatch,
  segmentPagerLine,
  type PagerMatch,
} from "../../ui-core/state/pager-search.js";
import { stripAnsi } from "../render/measure.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { padStartToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { isPrintable } from "./picker-panel.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export type PagerFormat = "formatted" | "raw";
export type PagerMarkdownMode = "auto" | "force" | "plain";

export interface PagerPanelState {
  readonly caret: number;
  readonly top: number;
  readonly format: PagerFormat;
  readonly follow: boolean;
  readonly finding: boolean;
  readonly draft: string;
  readonly query: string;
  readonly matchIndex: number;
}

export const PAGER_INITIAL_STATE: PagerPanelState = {
  caret: 0,
  top: 0,
  format: "formatted",
  follow: false,
  finding: false,
  draft: "",
  query: "",
  matchIndex: 0,
};

export function resolvePagerMarkdownMode(
  body: string,
  requested: PagerMarkdownMode | undefined,
): "force" | "plain" {
  if (requested === "force" || requested === "plain") return requested;
  return defaultPagerMarkdownMode({ body });
}

function formattedPagerBody(body: string): string {
  const stripped = stripPagerLineGutters(body);
  if (/^\d+:\s?/m.test(body) || /^#\s*fs\.read\b/im.test(body)) {
    return extractFsReadFileBody(body) || stripped;
  }
  return stripped;
}

function logicalPagerLines(body: string, width: number, format: PagerFormat): readonly string[] {
  if (format === "formatted") {
    const rendered = renderMarkdownLines(formattedPagerBody(body), {
      width: Math.max(20, width),
      stripOuterIndent: true,
    });
    if (rendered.length > 0) return rendered;
  }
  return body.replace(/\r\n?/g, "\n").split("\n");
}

export function pagerLines(
  body: string,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER,
  format: PagerFormat = "formatted",
): readonly string[] {
  const width = panelBodyWidth(columns);
  const textWidth = Math.max(1, width - 2);
  const lines = logicalPagerLines(body, textWidth, format).flatMap((line) =>
    format === "formatted"
      ? wrapAnsiLine(line, textWidth)
      : wrapPagerLine(line, textWidth),
  );
  return lines.length === 0 ? [" "] : lines;
}

function pagerSearchLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => stripAnsi(line));
}

export interface PagerViewModel {
  readonly lines: readonly string[];
  readonly searchLines: readonly string[];
}

let pagerCache:
  | {
      readonly body: string;
      readonly columns: number;
      readonly rows: number;
      readonly format: PagerFormat;
      readonly view: PagerViewModel;
    }
  | undefined;

export function pagerViewModel(
  body: string,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER,
  format: PagerFormat = "formatted",
): PagerViewModel {
  const hit = pagerCache;
  if (
    hit !== undefined &&
    hit.body === body &&
    hit.columns === columns &&
    hit.rows === rows &&
    hit.format === format
  ) {
    return hit.view;
  }
  const lines = pagerLines(body, columns, rows, format);
  const view: PagerViewModel = { lines, searchLines: pagerSearchLines(lines) };
  pagerCache = { body, columns, rows, format, view };
  return view;
}
function clampTop(caret: number, top: number, height: number, count: number): number {
  const max = Math.max(0, count - height);
  let next = Math.max(0, Math.min(top, max));
  if (caret < next) next = caret;
  if (caret > next + height - 1) next = caret - height + 1;
  return Math.max(0, Math.min(next, max));
}

export interface PagerKeyInput {
  readonly state: PagerPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly lines: readonly string[];
  readonly searchLines?: readonly string[] | undefined;
  readonly rows: number;
  readonly live: boolean;
  readonly body: string;
}

export function pagerKey(input: PagerKeyInput): PanelKeyResult<PagerPanelState> {
  const { state, chord } = input;
  const searchLines = input.searchLines ?? pagerSearchLines(input.lines);
  const height = Math.max(1, panelBodyHeight(input.rows));
  const count = input.lines.length;

  if (state.finding) {
    if (chord === "enter") {
      const query = state.draft;
      const matches = findPagerMatches(searchLines, query);
      const first = matches[0];
      const caret = first ? first.line : state.caret;
      return handled({
        ...state,
        finding: false,
        query,
        matchIndex: 0,
        caret,
        top: clampTop(caret, state.top, height, count),
      });
    }
    if (chord === "escape") return handled({ ...state, finding: false, draft: "" });
    if (chord === "backspace") return handled({ ...state, draft: state.draft.slice(0, -1) });
    if (isPrintable(chord, input.text)) {
      return handled({ ...state, draft: `${state.draft}${input.text ?? ""}` });
    }
    return handled(state);
  }

  const moveTo = (caret: number): PanelKeyResult<PagerPanelState> => {
    const next = Math.max(0, Math.min(caret, Math.max(0, count - 1)));
    return handled({
      ...state,
      caret: next,
      top: clampTop(next, state.top, height, count),
      follow: false,
    });
  };

  if (chord === "up" || chord === "k") return moveTo(state.caret - 1);
  if (chord === "down" || chord === "j") return moveTo(state.caret + 1);
  if (chord === "pageup") return moveTo(state.caret - height);
  if (chord === "pagedown" || chord === "space") return moveTo(state.caret + height);
  if (chord === "home" || chord === "g") return moveTo(0);
  if (chord === "end" || chord === "shift+g") return moveTo(count - 1);
  if (chord === "ctrl+r") return handled({ ...state, finding: true, draft: state.query });

  if (chord === "n" || chord === "shift+n") {
    if (state.query === "") return handled(state);
    const matches: readonly PagerMatch[] = findPagerMatches(searchLines, state.query);
    if (matches.length === 0) return handled(state);
    const index =
      chord === "n"
        ? nextPagerMatch(matches, state.matchIndex)
        : prevPagerMatch(matches, state.matchIndex);
    const caret = matches[index]?.line ?? state.caret;
    return handled({
      ...state,
      matchIndex: index,
      caret,
      top: clampTop(caret, state.top, height, count),
    });
  }

  if (chord === "f") return handled({ ...state, format: "formatted" });
  if (chord === "r") return handled({ ...state, format: "raw" });
  if (chord === "l" && input.live) return handled({ ...state, follow: !state.follow });
  if (chord === "s") return handled(state, { kind: "pager-export-scrollback" });
  if (chord === "e") return handled(state, { kind: "pager-export-editor" });
  if (chord === "c") return handled(state, { kind: "copy", text: input.body });
  if (chord === "q") return handled(state, { kind: "close" });
  return unhandled(state);
}

export interface PagerViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly title: string;
  readonly lines: readonly string[];
  readonly searchLines?: readonly string[] | undefined;
  readonly state: PagerPanelState;
  readonly live?: boolean | undefined;
}

function paintSegments(
  ink: InkTheme,
  line: string,
  lineIndex: number,
  matches: readonly PagerMatch[],
  activeMatchIndex: number,
): string {
  const segments = segmentPagerLine(line, lineIndex, matches, activeMatchIndex);
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "plain") out += segment.text;
    else if (segment.kind === "match") out += ink.inverse(segment.text);
    else out += ink.style(segment.text, { inverse: true, bold: true });
  }
  return sealStyle(out);
}

export function pagerView(input: PagerViewInput): PanelFrameInput {
  const { ink, state } = input;
  const height = panelBodyHeight(input.rows);
  const count = input.lines.length;
  const searchLines = input.searchLines ?? pagerSearchLines(input.lines);
  const matches = state.query === "" ? [] : findPagerMatches(searchLines, state.query);
  const top = clampTop(state.caret, state.top, Math.max(1, height), count);
  const body: string[] = [];
  for (let offset = 0; offset < height; offset += 1) {
    const index = top + offset;
    if (index >= count) break;
    const raw = input.lines[index] ?? "";
    const plain = searchLines[index] ?? "";
    const painted =
      state.query === ""
        ? sealStyle(raw)
        : paintSegments(ink, plain, index, matches, state.matchIndex);
    const caret = index === state.caret ? ink.fg("inputBorder", ink.glyphs.caret) : " ";
    body.push(sealStyle(`${caret} ${painted}`));
  }

  const tags: string[] = [state.format === "raw" ? "raw" : "md"];
  if (state.follow) tags.push("follow");

  const hints = state.finding
    ? [`find: ${state.draft}`, `${ink.glyphs.enter} search`, "esc cancel"]
    : [
        `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown} jk`,
        "^R find",
        "n/N",
        "f fmt",
        "r raw",
        ...(input.live === true ? ["l follow"] : []),
        "s scroll",
        "e ed",
        "c copy",
        "q",
      ];

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: input.title,
    borderColor: "border",
    counter: count === 0 ? undefined : `${Math.min(state.caret + 1, count)}/${count}`,
    tags,
    hints,
    body,
  };
}
