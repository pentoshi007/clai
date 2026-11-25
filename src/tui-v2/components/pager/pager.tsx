/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { StyledText, TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import { overlaySize } from "../../../ui-core/layout/overlay-size.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { ArtifactPagerSource } from "../../../ui-core/rendering/artifact-pager-source.js";
import { fitOneLine, padChromeRow, PAGER_HELP_FULL, PAGER_HELP_MED, PAGER_HELP_MIN, PAGER_HELP_SHORT } from "../../../ui-core/rendering/pager-chrome.js";
import { preparePagerDisplay, type PagerMarkdownMode } from "../../rendering/pager-markdown.js";
import { subagentAnsiPaint } from "../../rendering/subagent-ansi.js";
import { subagentBodySpans } from "../../../ui-core/rendering/subagent-presentation.js";
import { extractFsReadFileBody, stripPagerLineGutters } from "../../../ui-core/rendering/pager-source.js";
import { sanitizeDisplayText } from "../../../ui-core/rendering/sanitize-display.js";
import { pagerCommandColor, pagerRegionsForPage, type PagerBodyRegions } from "../../../ui-core/rendering/pager-regions.js";
import { PagerLine, bodyOnlyForCopy, parseDiffLine } from "./pager-line.js";
import { buildPagerRows, pagerRowId, pagerRowSearch, pagerRowWindow, slicePagerSpans, type PagerRow } from "./pager-rows.js";
import { usePagerDocument, type PagerDocument } from "./pager-document.js";
import { usePagerViewport } from "./pager-viewport.js";
import { usePagerFind } from "./pager-find.js";

export interface PagerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly title: string;
  readonly body: string;
  readonly source?: ArtifactPagerSource | undefined;
  readonly highlightPath?: string | undefined;
  readonly markdown?: PagerMarkdownMode | undefined;
  readonly regions?: PagerBodyRegions | undefined;
}

export { bodyOnlyForCopy } from "./pager-line.js";
type ViewMode = "formatted" | "raw";
const HIDDEN_SCROLLBARS = { visible: false, showArrows: false } as const;

function useGeometry() {
  const term = useTerminalDimensionsContext();
  const size = overlaySize(term.width, term.height);
  const border = size.width >= 5 && size.height >= 3;
  const innerH = Math.max(1, size.height - (border ? 2 : 0));
  const padding = size.width >= 8 ? 1 : 0;
  const cols = Math.max(1, size.width - (border ? 2 : 0) - padding * 2);
  return { size, border, padding, innerH, cols, height: Math.max(1, innerH - Number(innerH >= 3) - Number(innerH >= 2)) };
}

function formatBody(body: string): string {
  const stripped = stripPagerLineGutters(body);
  if (/^\d+:\s?|^#\s*fs\.read\b/m.test(body)) return extractFsReadFileBody(body) || stripped;
  return stripped;
}

function usePagerLayout(props: PagerProps, doc: PagerDocument, cols: number, mode: ViewMode) {
  const { theme, services, source, highlightPath, regions } = props;
  const raw = mode === "raw";
  const isSubagent = source?.path.startsWith("memory://subagent/") ?? false;
  const colorMode = services.capabilities.colorMode;
  const display = useMemo(() => {
    const body = doc.body.replace(/\t/g, "    ");
    const clean = !raw && !isSubagent && !source?.diffLines ? formatBody(body) : body;
    return preparePagerDisplay({ body: clean, width: cols, mode: raw ? "plain" : "force", defaultFg: theme.foreground,
      theme, colorMode, quotePrefix: source?.quotePrefix, literalQuotes: source?.literalQuotes,
      lineChangeColors: source?.lineChangeColors, diffLines: source?.diffLines,
      subagentPaint: isSubagent ? subagentAnsiPaint(theme, colorMode) : undefined });
  }, [doc.body, cols, raw, isSubagent, theme, source, colorMode]);
  const lines = useMemo(() => display.lines.map(line => line.plain), [display]);
  const useDiffGutters = raw && Boolean(highlightPath) && cols >= 16;
  const searchLines = useMemo(() => useDiffGutters ? lines.map(line => parseDiffLine(line)?.code ?? line) : lines, [lines, useDiffGutters]);
  const subagentSpans = useMemo(() => isSubagent && display.mode === "plain" ? subagentBodySpans(lines) : undefined, [isSubagent, display, lines]);
  const tone = source?.commandTone?.() ?? regions?.inputTone;
  const rows = useMemo(() => buildPagerRows({ display, lines, contentCols: cols, useDiffGutters, isSubagent,
    highlightPath: raw ? highlightPath ?? "" : "", wrapRows: true,
    regions: raw ? pagerRegionsForPage(source?.regions ? source.regions() : regions, doc.page?.offset) : undefined,
  }), [display, lines, cols, useDiffGutters, isSubagent, highlightPath, raw, source, regions, doc.page?.offset, tone]);
  return { rows, display, lines, searchLines, subagentSpans, isSubagent, tone, path: raw && highlightPath ? highlightPath : props.title };
}

function usePagerView(props: PagerProps) {
  const geometry = useGeometry();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const doc = usePagerDocument(props.source, props.body, scroll);
  const [mode, setMode] = useState<ViewMode>(props.markdown === "force" ? "formatted" : "raw");
  const layout = usePagerLayout(props, doc, geometry.cols, mode);
  const viewport = usePagerViewport(scroll, doc, geometry.height, layout.rows.length);
  const [status, setStatus] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function flash(text: string): void {
    clearTimeout(timer.current);
    setStatus(text);
    doc.clearError();
    timer.current = setTimeout(() => setStatus(undefined), 1800);
  }
  const find = usePagerFind(layout.searchLines, layout.rows, doc, viewport, flash);
  const changeMode = (next: ViewMode): void => {
    setMode(next);
    find.select(-1);
    flash(next === "formatted" ? "view: formatted (markdown)" : "view: raw");
    queueMicrotask(() => scroll.current?.scrollTo(0));
  };
  return { ...props, geometry, layout, doc, viewport, scroll, find, mode, changeMode, status, flash };
}
type View = ReturnType<typeof usePagerView>;

function scrollAction(action: string, v: View): boolean {
  const height = v.viewport.height;
  const half = Math.max(1, Math.floor(height / 2));
  switch (action) {
    case "pager.line-up": v.viewport.move(-1); break;
    case "pager.line-down": v.viewport.move(1); break;
    case "pager.page-up": v.viewport.move(-height); break;
    case "pager.page-down": v.viewport.move(height); break;
    case "pager.half-page-up": v.viewport.move(-half); break;
    case "pager.half-page-down": v.viewport.move(half); break;
    case "pager.top": v.doc.jump("top"); break;
    case "pager.bottom": v.doc.jump("bottom"); break;
    default: return false;
  }
  return true;
}

async function copyBody(v: View): Promise<void> {
  try {
    const body = v.source ? await v.source.readAll() : v.body;
    await v.services.ports.clipboard.writeText(bodyOnlyForCopy(body));
    v.flash("copied all");
    v.services.toast.success("Copied pager body", { key: "clipboard", durationMs: 1500 });
  } catch {
    v.flash("copy failed");
    v.services.toast.error("Copy failed", { key: "clipboard" });
  }
}

function toggleFollow(v: View): void {
  if (!v.doc.canFollow) { v.flash("this view has no live source"); return; }
  v.flash(v.doc.following ? "follow paused" : "following live output");
  v.doc.toggleFollow();
}

function usePagerKeys(v: View): void {
  useKeyboard(key => {
    if (key.defaultPrevented || key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    const action = v.services.router.resolve(chord, "pager");
    if (v.find.open) {
      if (chord === "escape") v.find.clear();
      else if (action === "pager.search" || chord === "up") v.find.step(-1);
      else if (chord === "down") v.find.step(1);
      else return;
    } else if (action) {
      if (!scrollAction(action, v)) viewAction(action, v);
    } else if (chord === "escape" && v.find.active) v.find.clear();
    else return;
    key.preventDefault();
  });
}

function viewAction(action: string, v: View): void {
  switch (action) {
    case "pager.search": v.find.edit(true); break;
    case "pager.next-match": v.find.step(1); break;
    case "pager.prev-match": v.find.step(-1); break;
    case "pager.copy": void copyBody(v); break;
    case "pager.format": v.changeMode("formatted"); break;
    case "pager.raw": v.changeMode("raw"); break;
    case "pager.toggle-follow": toggleFollow(v); break;
    case "pager.close": if (v.find.active) v.find.clear(); else v.services.overlay.close(); break;
  }
}

function scrollPosition(v: View): string {
  const page = v.doc.page;
  if (!page || page.offset === 0 && page.nextOffset === page.totalBytes) return v.viewport.hint;
  const fraction = v.viewport.top / Math.max(1, v.layout.rows.length - v.viewport.height);
  const byte = page.offset + fraction * (page.nextOffset - page.offset);
  return `${Math.round(100 * Math.min(1, byte / page.totalBytes))}%`;
}

function footerHint(v: View): string {
  if (v.doc.error) return `pager error: ${v.doc.error}`;
  if (v.status) return v.status;
  if (v.find.active) return "n/N:next  ·  esc:clear-find  ·  q:close";
  const width = Math.max(12, Math.floor(v.geometry.cols * 0.78));
  if (v.doc.canFollow) {
    const live = v.doc.following ? "● following" : "❙❙ paused (running)";
    const state = v.source?.isGrowing?.() ? live : "finished";
    return fitOneLine([`l:${v.doc.following ? "pause" : "follow"}  ·  ${state}  ·  c:copy`, `l:follow  ·  ${state}`, state], width);
  }
  const label = v.mode === "formatted" ? "fmt" : "raw";
  return fitOneLine([`f:format  ·  r:raw  ·  view:${label}  ·  c:copy`, `f:fmt  ·  r:raw  ·  ${label}`, "f:format  ·  r:raw  ·  c:copy"], width);
}

function PagerHeader({ v }: { v: View }): ReactNode {
  const { cols } = v.geometry;
  const { theme, find } = v;
  if (find.open) {
    const status = find.active ? find.label || "no matches" : "type to search";
    const hint = fitOneLine([`${status} · ↑↓ prev/next · enter done · esc clear`, status], Math.max(8, Math.floor(cols * 0.35)));
    return <box style={{ flexDirection: "row", width: "100%", height: 1, minWidth: 0 }}>
      <text selectable={false} content=" ^R " style={{ fg: theme.background, bg: theme.cyan, attributes: TextAttributes.BOLD, height: 1 }} />
      <text selectable={false} content=" " style={{ height: 1 }} />
      <input focused value={find.query} onInput={find.change} onSubmit={find.submit} textColor={theme.foreground} backgroundColor={theme.rowB} style={{ flexGrow: 1, minWidth: 0 }} />
      <text selectable={false} content={hint} style={{ fg: theme.muted, flexShrink: 0, height: 1 }} />
    </box>;
  }
  const hints = find.active ? [`find:${find.query.trim()} ${find.label}`, `find:${find.label}`, "find"] : [PAGER_HELP_FULL, PAGER_HELP_MED, PAGER_HELP_SHORT, PAGER_HELP_MIN, "^r:search · q:close"];
  const left = fitOneLine(hints, Math.max(8, Math.floor(cols * 0.65)));
  const page = v.doc.page;
  const partial = page && (page.offset > 0 || page.nextOffset < page.totalBytes);
  const pos = scrollPosition(v);
  const right = partial ? pos : `${v.layout.lines.length} lines · ${pos}`;
  return <text selectable={false} content={padChromeRow(left, right, cols)} style={{ fg: theme.muted, height: 1, width: "100%" }} />;
}

function renderRow(v: View, row: PagerRow): ReactNode {
  const { layout, find, theme } = v;
  const offset = row.textOffset ?? 0;
  const search = pagerRowSearch(find.grouped.get(row.index), offset, row.textLength ?? row.line.length);
  const markdown = row.kind === "markdown";
  const styled = markdown ? layout.display.lines[row.index]?.styled : undefined;
  const spans = layout.subagentSpans?.[row.index];
  return <box key={row.key} style={{ height: 1, flexShrink: 0, width: "100%" }}>
    <PagerLine id={pagerRowId(row)} line={row.line} index={row.index} theme={theme} matches={search.matches} activeMatchIndex={search.active}
      hasQuery={find.active} highlightPath={markdown ? "" : layout.path} spans={row.spans}
      styled={styled && new StyledText(slicePagerSpans(styled.chunks, offset, row.line.length))} markdownMode={markdown}
      diffGutters={row.kind === "plain" || row.kind === "subagent" ? false : undefined} subagent={layout.isSubagent}
      subagentSpans={spans && slicePagerSpans(spans, offset, row.line.length)} tone={row.tone} />
  </box>;
}

function PagerContent({ v }: { v: View }): ReactNode {
  const { layout, viewport, geometry, theme } = v;
  const { start, end } = pagerRowWindow(layout.rows.length, viewport.top, viewport.height);
  const command = v.source?.commandText?.();
  const rows = useMemo(() => layout.rows.slice(start, end).map(row => renderRow(v, row)),
    [layout.rows, start, end, layout.display, layout.path, layout.subagentSpans, v.find.grouped, theme]);
  return <scrollbox ref={v.scroll} viewportCulling scrollY scrollX={false} stickyScroll={v.doc.following} stickyStart="bottom"
    scrollbarOptions={HIDDEN_SCROLLBARS} verticalScrollbarOptions={HIDDEN_SCROLLBARS} horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
    style={{ flexGrow: 1, flexShrink: 1, width: "100%", minHeight: 1, backgroundColor: theme.background, paddingLeft: geometry.padding, paddingRight: geometry.padding }}
    onMouseScroll={event => viewport.wheel(event.scroll?.direction)}>
    {command ? <text id="pager-command" selectable wrapMode="word" content={`command: ${sanitizeDisplayText(command)}\n`}
      style={{ width: "100%", flexShrink: 0, fg: theme[pagerCommandColor(layout.tone ?? "running")], bg: theme.background }} /> : null}
    <box key="before" style={{ height: start, flexShrink: 0 }} />{rows}<box key="after" style={{ height: layout.rows.length - end, flexShrink: 0 }} />
  </scrollbox>;
}

export function Pager(props: PagerProps): ReactNode {
  const v = usePagerView(props);
  usePagerKeys(v);
  const { theme, geometry } = v;
  const bar = { width: "100%", height: 1, flexShrink: 0, backgroundColor: theme.rowB, paddingLeft: geometry.padding, paddingRight: geometry.padding } as const;
  const title = ` ${fitOneLine([sanitizeDisplayText(v.title)], Math.max(1, geometry.size.width - 4))} `;
  return <box border={geometry.border} borderStyle="rounded" title={title} titleAlignment="left" titleColor={theme.cyan}
    style={{ flexDirection: "column", ...geometry.size, borderColor: theme.border, backgroundColor: theme.statusBackground }}>
    {geometry.innerH >= 3 ? <box style={bar}><PagerHeader v={v} /></box> : null}
    <PagerContent v={v} />
    {geometry.innerH >= 2 ? <box style={bar}><text selectable={false} content={padChromeRow(footerHint(v), scrollPosition(v), geometry.cols)}
      style={{ fg: v.doc.error ? theme.mode : theme.muted, height: 1, width: "100%" }} /></box> : null}
  </box>;
}
