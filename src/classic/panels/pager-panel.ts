import type { OverlayState } from "../../ui-core/controllers/overlay-controller.js";
import type { ArtifactPagerSource } from "../../ui-core/rendering/artifact-pager-source.js";
import { renderMarkdownLines } from "../../ui-core/rendering/render-markdown-lines.js";
import { defaultPagerMarkdownMode } from "../../ui-core/rendering/pager-view-policy.js";
import { extractFsReadFileBody, stripPagerLineGutters } from "../../ui-core/rendering/pager-source.js";
import { wrapPagerLine } from "../../ui-core/rendering/pager-chrome.js";
import {
  renderSubagentMarkdownLines,
  styleSubagentBody,
  subagentBodySpans,
  type SubagentSpan,
  type SubagentSpanPaint,
} from "../../ui-core/rendering/subagent-presentation.js";
import {
  findPagerMatches,
  nearestPagerMatch,
  nextPagerMatch,
  prevPagerMatch,
  segmentPagerLine,
  type PagerMatch,
} from "../../ui-core/state/pager-search.js";
import { hasSearchQuery, matchCounterLabel } from "../../ui-core/state/text-search.js";
import { stripAnsi } from "../render/measure.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { expandTabs, padStartToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { isPrintable } from "./picker-panel.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";
import { diffPagerLines } from "./pager-diff.js";
import { regionPagerLines } from "./pager-region-paint.js";
import { paintSearchMatches } from "./pager-search-paint.js";
import { pagerRegionsForPage, type PagerBodyRegions } from "../../ui-core/rendering/pager-regions.js";

export type PagerFormat = "formatted" | "raw";
export type PagerSourceStyle = Partial<Pick<ArtifactPagerSource, "quotePrefix" | "literalQuotes" | "lineChangeColors" | "diffLines">>;
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
  matchIndex: -1,
};

export function pagerActiveQuery(state: Pick<PagerPanelState, "finding" | "draft" | "query">): string {
  return state.finding ? state.draft : state.query;
}

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

function logicalPagerLines(
  body: string,
  width: number,
  format: PagerFormat,
  appearance?: Partial<Pick<InkTheme, "theme" | "colorMode">> & PagerSourceStyle,
  subagentPaint?: SubagentSpanPaint,
): readonly string[] {
  if (format === "formatted") {
    const options = {
      width: Math.max(20, width),
      stripOuterIndent: true,
      theme: appearance?.theme,
      colorMode: appearance?.colorMode,
      quotePrefix: appearance?.quotePrefix,
      literalQuotes: appearance?.literalQuotes,
      lineChangeColors: appearance?.lineChangeColors,
      diffLines: appearance?.diffLines,
    };
    const rendered = subagentPaint
      ? renderSubagentMarkdownLines(body, options, subagentPaint)
      : renderMarkdownLines(appearance?.diffLines ? body : formattedPagerBody(body), options);
    if (rendered.length > 0) return rendered;
  }
  return (subagentPaint ? styleSubagentBody(body, subagentPaint) : body).replace(/\r\n?/g, "\n").split("\n");
}

export interface PagerPaintOptions {
  readonly path?: string | undefined;
  readonly ink?: InkTheme | undefined;
  readonly regions?: PagerBodyRegions | undefined;
}

function rawPaintedLines(logical: readonly string[], width: number, paint: PagerPaintOptions): readonly string[] | undefined {
  const { path, ink, regions } = paint;
  const diff = path ? diffPagerLines(logical, width, ink ? { path, ink } : { path }) : undefined;
  if (diff) return diff;
  if (!regions || !ink || ink.colorMode === "none") return undefined;
  return regionPagerLines(logical, width, regions, path, ink);
}

export function pagerLines(
  body: string,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER,
  format: PagerFormat = "formatted",
  ansiBody = false,
  appearance?: Partial<Pick<InkTheme, "theme" | "colorMode">> & PagerSourceStyle,
  paint?: PagerPaintOptions,
  subagentPaint?: SubagentSpanPaint,
): readonly string[] {
  const width = panelBodyWidth(columns);
  const textWidth = Math.max(1, width - (width >= 3 ? 2 : 0));
  const logical = logicalPagerLines(body, textWidth, format, appearance, subagentPaint).map((line) => expandTabs(line));
  if (paint && format === "raw" && !ansiBody) {
    const painted = rawPaintedLines(logical, textWidth, paint);
    if (painted) return painted.length === 0 ? [" "] : painted;
  }
  const lines = logical.flatMap((line) =>
    format === "formatted" || ansiBody
      ? wrapAnsiLine(line, textWidth)
      : wrapPagerLine(line, textWidth, { preserveWhitespace: true }),
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

export function pagerPaintOptions(
  overlay: OverlayState,
  ink?: InkTheme,
  pageOffset = 0,
): PagerPaintOptions | undefined {
  if (overlay.kind !== "pager") return undefined;
  const path = overlay.highlightPath || undefined;
  const currentRegions = overlay.source?.regions ? overlay.source.regions() : overlay.regions;
  const regions = pagerRegionsForPage(currentRegions, pageOffset);
  if (!path && !regions) return undefined;
  return { ...(path ? { path } : {}), ...(ink ? { ink } : {}), ...(regions ? { regions } : {}) };
}

function regionsKey(regions: PagerBodyRegions | undefined): string {
  return regions ? `${regions.inputEnd ?? ""}:${regions.inputTone ?? ""}:${regions.codeStart ?? ""}:${regions.codeEnd ?? ""}` : "";
}

const unpaintSubagentSpan: SubagentSpanPaint = (span) => span.text;
const subagentPaintCache = new WeakMap<InkTheme, SubagentSpanPaint>();

export function pagerSubagentPaint(overlay: OverlayState, ink?: InkTheme): SubagentSpanPaint | undefined {
  if (overlay.kind !== "pager" || !overlay.source?.path.startsWith("memory://subagent/")) return undefined;
  if (!ink) return unpaintSubagentSpan;
  let paint = subagentPaintCache.get(ink);
  if (!paint) {
    paint = (span) => ink.style(span.text, span);
    subagentPaintCache.set(ink, paint);
  }
  return paint;
}

interface PagerCacheEntry {
  readonly body: string;
  readonly columns: number;
  readonly rows: number;
  readonly format: PagerFormat;
  readonly ansiBody: boolean;
  readonly appearance: Pick<InkTheme, "theme" | "colorMode"> | undefined;
  readonly diffPath: string | undefined;
  readonly diffInk: InkTheme | undefined;
  readonly regions: string;
  readonly subagentPaint: SubagentSpanPaint | undefined;
  readonly quotePrefix: string | undefined;
  readonly literalQuotes: boolean | undefined;
  readonly lineChangeColors: boolean | undefined;
  readonly diffLines: boolean | undefined;
  readonly view: PagerViewModel;
}

const PAGER_CACHE_SIZE = 4;
const pagerCache: PagerCacheEntry[] = [];
const subagentSpansCache = new WeakMap<readonly string[], readonly (readonly SubagentSpan[] | undefined)[]>();

function pagerSubagentSpans(lines: readonly string[]): readonly (readonly SubagentSpan[] | undefined)[] {
  let spans = subagentSpansCache.get(lines);
  if (!spans) {
    spans = subagentBodySpans(lines);
    subagentSpansCache.set(lines, spans);
  }
  return spans;
}

export function pagerViewModel(
  body: string,
  columns: number,
  rows = Number.MAX_SAFE_INTEGER,
  format: PagerFormat = "formatted",
  ansiBody = false,
  appearance?: Pick<InkTheme, "theme" | "colorMode">,
  paint?: PagerPaintOptions,
  subagentPaint?: SubagentSpanPaint,
  style?: PagerSourceStyle,
): PagerViewModel {
  const quotePrefix = style?.quotePrefix;
  const literalQuotes = style?.literalQuotes;
  const lineChangeColors = style?.lineChangeColors;
  const diffLines = style?.diffLines;
  const diffPath = paint?.path;
  const diffInk = paint?.ink;
  const regions = regionsKey(paint?.regions);
  const index = pagerCache.findIndex(
    (entry) =>
      entry.body === body &&
      entry.columns === columns &&
      entry.rows === rows &&
      entry.format === format &&
      entry.ansiBody === ansiBody &&
      entry.appearance === appearance &&
      entry.diffPath === diffPath &&
      entry.diffInk === diffInk &&
      entry.regions === regions &&
      entry.subagentPaint === subagentPaint &&
      entry.quotePrefix === quotePrefix &&
      entry.literalQuotes === literalQuotes &&
      entry.lineChangeColors === lineChangeColors &&
      entry.diffLines === diffLines,
  );
  if (index >= 0) {
    const hit = pagerCache[index]!;
    if (index > 0) {
      pagerCache.splice(index, 1);
      pagerCache.unshift(hit);
    }
    return hit.view;
  }
  const markdownAppearance = { ...appearance, quotePrefix, literalQuotes, lineChangeColors, diffLines };
  const lines = pagerLines(body, columns, rows, format, ansiBody, markdownAppearance, paint, subagentPaint);
  const view: PagerViewModel = { lines, searchLines: pagerSearchLines(lines) };
  pagerCache.unshift({ body, columns, rows, format, ansiBody, appearance, diffPath, diffInk, regions, subagentPaint, quotePrefix, literalQuotes, lineChangeColors, diffLines, view });
  if (pagerCache.length > PAGER_CACHE_SIZE) pagerCache.length = PAGER_CACHE_SIZE;
  return view;
}

function centeredTop(caret: number, height: number, count: number): number {
  return Math.max(0, Math.min(caret - Math.floor(height / 2), Math.max(0, count - height)));
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

  const focusMatch = (next: PagerPanelState, matches: readonly PagerMatch[], index: number): PanelKeyResult<PagerPanelState> => {
    const match = matches[index];
    if (!match) return handled({ ...next, matchIndex: -1 });
    return handled({
      ...next,
      matchIndex: index,
      caret: match.line,
      top: centeredTop(match.line, height, count),
      follow: false,
    });
  };

  const stepMatch = (next: PagerPanelState, query: string, delta: 1 | -1): PanelKeyResult<PagerPanelState> => {
    const matches = findPagerMatches(searchLines, query);
    if (matches.length === 0) return handled(next);
    const valid = next.matchIndex >= 0 && next.matchIndex < matches.length;
    const index = !valid
      ? nearestPagerMatch(matches, next.caret)
      : delta > 0
        ? nextPagerMatch(matches, next.matchIndex)
        : prevPagerMatch(matches, next.matchIndex);
    return focusMatch(next, matches, index);
  };

  const refine = (draft: string): PanelKeyResult<PagerPanelState> => {
    const previous = findPagerMatches(searchLines, state.draft)[state.matchIndex];
    const matches = findPagerMatches(searchLines, draft);
    const index = previous
      ? nearestPagerMatch(matches, previous.line, previous.column)
      : nearestPagerMatch(matches, state.caret);
    return focusMatch({ ...state, draft }, matches, index);
  };

  if (state.finding) {
    if (chord === "enter") {
      const query = state.draft;
      if (!hasSearchQuery(query)) return handled({ ...state, finding: false, draft: "", query: "", matchIndex: -1 });
      const matches = findPagerMatches(searchLines, query);
      const committed = { ...state, finding: false, query };
      if (state.matchIndex >= 0 && state.matchIndex < matches.length) return handled(committed);
      return matches.length > 0
        ? focusMatch(committed, matches, nearestPagerMatch(matches, state.caret))
        : handled({ ...committed, matchIndex: -1 });
    }
    if (chord === "escape") {
      const matches = findPagerMatches(searchLines, state.query);
      return handled({
        ...state,
        finding: false,
        draft: "",
        matchIndex: Math.min(state.matchIndex, matches.length - 1),
      });
    }
    if (chord === "up" || chord === "ctrl+r") return stepMatch(state, state.draft, -1);
    if (chord === "down") return stepMatch(state, state.draft, 1);
    if (chord === "backspace") return refine(state.draft.slice(0, -1));
    if (chord === "ctrl+u") return refine("");
    if (chord === "ctrl+w" || chord === "alt+backspace" || chord === "ctrl+backspace") {
      return refine(state.draft.replace(/\s*\S+\s*$/u, ""));
    }
    if (isPrintable(chord, input.text)) return refine(`${state.draft}${input.text ?? ""}`);
    return handled(state);
  }

  if (chord === "escape" && state.query !== "") return handled({ ...state, query: "", matchIndex: -1 });

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
  if (chord === "home" || chord === "g" || chord === "ctrl+u") return moveTo(0);
  if (chord === "end" || chord === "shift+g" || chord === "ctrl+d") return moveTo(count - 1);
  if (chord === "ctrl+r") return handled({ ...state, finding: true, draft: state.query });

  if (chord === "n" || chord === "shift+n") {
    if (!hasSearchQuery(state.query)) return handled(state);
    return stepMatch(state, state.query, chord === "n" ? 1 : -1);
  }

  if (chord === "f") return handled({ ...state, format: "formatted" });
  if (chord === "r") return handled({ ...state, format: "raw" });
  if (chord === "l" && input.live) return handled({ ...state, follow: !state.follow });
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
  readonly subagent?: boolean | undefined;
}

export function pagerView(input: PagerViewInput): PanelFrameInput {
  const { ink, state } = input;
  const height = panelBodyHeight(input.rows);
  const count = input.lines.length;
  const searchLines = input.searchLines ?? pagerSearchLines(input.lines);
  const query = pagerActiveQuery(state);
  const matches = hasSearchQuery(query) ? findPagerMatches(searchLines, query) : [];
  const top = clampTop(state.caret, state.top, Math.max(1, height), count);
  const subagentSpans = input.subagent ? pagerSubagentSpans(searchLines) : undefined;
  const body: string[] = [];
  for (let offset = 0; offset < height; offset += 1) {
    const index = top + offset;
    if (index >= count) break;
    const raw = input.lines[index] ?? "";
    const plain = searchLines[index] ?? "";
    const spans = raw.includes("\x1b[") ? undefined : subagentSpans?.[index];
    const styled = spans ? spans.map((span) => ink.style(span.text, span)).join("") : raw;
    const painted =
      matches.length === 0
        ? sealStyle(styled)
        : paintSearchMatches(ink, styled, segmentPagerLine(plain, index, matches, state.matchIndex));
    const caret = index === state.caret ? ink.fg("inputBorder", ink.glyphs.caret) : " ";
    body.push(sealStyle(`${panelBodyWidth(input.columns) >= 3 ? `${caret} ` : ""}${painted}`));
  }

  const tags: string[] = [state.format === "raw" ? "raw" : "md"];
  if (state.follow) tags.push("follow");

  const counter = matchCounterLabel(query, matches.length, state.matchIndex);
  const hints = state.finding
    ? [
        `find: ${state.draft}${ink.glyphs.caret}`,
        ...(counter ? [counter] : []),
        `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown} prev/next`,
        `${ink.glyphs.enter} done`,
        "esc cancel",
      ]
    : hasSearchQuery(state.query)
      ? [`find: ${state.query}`, ...(counter ? [counter] : []), "n/N next/prev", "^R edit", "esc clear", "q"]
      : [
          `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown} jk`,
          "^R find",
          "f fmt",
          "r raw",
          ...(input.live === true ? ["l follow"] : []),
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
