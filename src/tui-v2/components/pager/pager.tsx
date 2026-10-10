/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import { overlaySize } from "../../../ui-core/layout/overlay-size.js";
import { LayoutEvents, StyledText, TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { ArtifactPage, ArtifactPagerSource } from "../../../ui-core/rendering/artifact-pager-source.js";
import {
  findPagerMatches,
  nextPagerMatch,
  prevPagerMatch,
  type PagerMatch,
} from "../../../ui-core/state/pager-search.js";
import {
  fitOneLine,
  padChromeRow,
} from "../../../ui-core/rendering/pager-chrome.js";
import {
  preparePagerDisplay,
  type PagerMarkdownMode,
} from "../../rendering/pager-markdown.js";
import { subagentAnsiPaint } from "../../rendering/subagent-ansi.js";
import { subagentBodySpans } from "../../../ui-core/rendering/subagent-presentation.js";
import {
  extractFsReadFileBody,
  stripPagerLineGutters,
} from "../../../ui-core/rendering/pager-source.js";
import { sanitizeDisplayText } from "../../../ui-core/rendering/sanitize-display.js";
import {
  PagerLine,
  bodyOnlyForCopy,
  parseDiffLine,
} from "./pager-line.js";
import {
  buildPagerRows,
  groupPagerMatches,
  NO_MATCHES,
  pagerRowSearch,
  pagerRowWindow,
  slicePagerSpans,
} from "./pager-rows.js";

export interface PagerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly title: string;
  readonly body: string;
  readonly source?: ArtifactPagerSource | undefined;
  readonly highlightPath?: string | undefined;
  readonly markdown?: PagerMarkdownMode | undefined;
}

type PagerViewMode = "formatted" | "raw";

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;
const PAGER_RESIZE_EVENTS = ["resize", LayoutEvents.RESIZED] as const;

const PAGER_HELP_FULL =
  "↑↓:scroll  ·  pg↑↓:scroll  ·  home/end  ·  ^r:search  ·  q/esc:close";
const PAGER_HELP_MED =
  "↑↓:scroll  ·  ^r:search  ·  q/esc:close";
const PAGER_HELP_SHORT =
  "↑↓ · ^r:search · q:close";
const PAGER_HELP_MIN = "^r:search  ·  q/esc:close";

const PAGER_FOOTER_FULL =
  "f:format  ·  r:raw  ·  c:copy  ·  drag:select";
const PAGER_FOOTER_SHORT = "f:format  ·  r:raw  ·  c:copy";

export { bodyOnlyForCopy } from "./pager-line.js";

export function Pager(props: PagerProps): ReactNode {
  const {
    services,
    theme,
    title,
    body,
    source,
    highlightPath,
    markdown = "auto",
  } = props;
  const colorMode = services.capabilities.colorMode;
  const continuous = source?.layout === "continuous";
  const isSubagent = source?.path.startsWith("memory://subagent/") ?? false;
  const subagentPaint = useMemo(
    () => (isSubagent ? subagentAnsiPaint(theme, colorMode) : undefined),
    [isSubagent, theme, colorMode],
  );
  const { width: termWidth, height: termHeight } = useTerminalDimensionsContext();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [displayBody, setDisplayBody] = useState(body);
  const [artifactPage, setArtifactPage] = useState<ArtifactPage | undefined>(undefined);
  const [pageBusy, setPageBusy] = useState(false);
  const [viewMode, setViewMode] = useState<PagerViewMode>(() =>
    markdown === "force" ? "formatted" : "raw",
  );
  const size = overlaySize(termWidth, termHeight);
  const border = size.width >= 5 && size.height >= 3;
  const innerH = Math.max(1, size.height - (border ? 2 : 0));
  const padding = size.width >= 8 ? 1 : 0;
  const contentCols = Math.max(1, size.width - (border ? 2 : 0) - padding * 2);
  const chromeCols = contentCols;

  const display = useMemo(() => {
    const pagerBody = continuous ? displayBody.replace(/\t/g, "    ") : displayBody;
    if (viewMode === "formatted") {
      let clean = pagerBody;
      if (!isSubagent) {
        const stripped = stripPagerLineGutters(pagerBody);
        clean = /^\d+:\s?/m.test(pagerBody) || /^#\s*fs\.read\b/m.test(pagerBody)
          ? extractFsReadFileBody(pagerBody) || stripped
          : stripped;
      }
      return preparePagerDisplay({
        body: clean,
        width: contentCols,
        mode: "force",
        defaultFg: theme.foreground,
        theme,
        colorMode,
        subagentPaint: isSubagent ? subagentPaint : undefined,
      });
    }
    return preparePagerDisplay({
      body: pagerBody,
      width: contentCols,
      mode: "plain",
      defaultFg: theme.foreground,
      theme,
      colorMode,
    });
  }, [displayBody, contentCols, viewMode, theme, colorMode, isSubagent, subagentPaint, continuous]);

  const lines = useMemo(
    () => display.lines.map((l) => l.plain),
    [display.lines],
  );
  const subagentSpans = useMemo(
    () => (isSubagent && display.mode === "plain" ? subagentBodySpans(lines) : undefined),
    [isSubagent, display.mode, lines],
  );
  const pathForHighlight =
    viewMode === "raw" && highlightPath ? highlightPath : title;
  const useDiffGutters =
    viewMode === "raw" && Boolean(highlightPath) && display.mode === "plain" && contentCols >= 16;
  const searchLines = useMemo(() => {
    if (display.mode === "markdown" || !useDiffGutters) return lines;
    return lines.map((line) => {
      const p = parseDiffLine(line);
      return p ? p.code : line;
    });
  }, [lines, display.mode, useDiffGutters]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [scrollHint, setScrollHint] = useState("top");
  const canFollow = typeof source?.watch === "function";
  const startFollowing = canFollow && (source?.isGrowing?.() ?? true);
  const [following, setFollowing] = useState(startFollowing);
  const matches = useMemo(
    () => findPagerMatches(searchLines, query),
    [searchLines, query],
  );
  const [pagerError, setPagerError] = useState<string | undefined>(undefined);
  const [statusFlash, setStatusFlash] = useState<string | undefined>(undefined);
  const [viewport, setViewport] = useState({
    top: 0,
    height: Math.max(1, innerH - Number(innerH >= 3) - Number(innerH >= 2)),
  });
  const hasQuery = query.trim().length > 0;
  const rowModels = useMemo(
    () => buildPagerRows({
      display, lines, contentCols, useDiffGutters, isSubagent,
      highlightPath: pathForHighlight, wrapRows: continuous,
    }),
    [display, lines, contentCols, useDiffGutters, isSubagent, pathForHighlight, continuous],
  );
  const rowWindow = continuous
    ? pagerRowWindow(rowModels.length, viewport.top, viewport.height)
    : { start: 0, end: rowModels.length };

  useEffect(() => {
    setFollowing(startFollowing);
    if (!source) {
      setDisplayBody(body);
      setArtifactPage(undefined);
      return;
    }
    if (canFollow) return;
    let active = true;
    setPageBusy(true);
    void source.readPage(0).then((page) => {
      if (!active) return;
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output yet)");
    }).catch((error) => {
      if (active) setPagerError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setPageBusy(false); });
    return () => { active = false; };
  }, [body, source, canFollow, startFollowing]);

  const artifactOffset = useRef(0);
  const pendingPageScroll = useRef<"top" | "bottom" | undefined>(undefined);
  artifactOffset.current = artifactPage?.offset ?? 0;

  function applyPendingPageScroll(): void {
    const scroll = pendingPageScroll.current;
    const box = scrollRef.current;
    if (!scroll || !box) return;
    box.scrollTo(scroll === "bottom" ? Math.max(0, box.scrollHeight - box.viewport.height) : 0);
    refreshScrollHint();
  }

  useEffect(() => { applyPendingPageScroll(); }, [display]);

  useEffect(() => {
    if (!source?.watch) return;
    let active = true;
    let reading = false;
    let pending = false;
    const box = scrollRef.current;
    if (box && following) box.scrollTo(Math.max(0, box.scrollHeight - box.viewport.height));
    const pull = (): void => {
      if (!active) return;
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      const page = following && source.readTail
        ? source.readTail()
        : source.readPage(artifactOffset.current);
      void page
        .then((page) => {
          if (!active) return;
          setArtifactPage(page);
          setDisplayBody(page.body || "(no output yet)");
        })
        .catch((error) => {
          if (active) setPagerError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          reading = false;
          if (pending) {
            pending = false;
            pull();
          }
        });
    };
    const unwatch = source.watch(pull);
    pull();
    return () => {
      active = false;
      unwatch();
    };
  }, [source, following]);

  async function loadArtifactPage(
    offset: number,
    scroll: "top" | "bottom" = "top",
  ): Promise<void> {
    if (!source || pageBusy) return;
    setFollowing(false);
    setPageBusy(true);
    try {
      const page = await source.readPage(offset);
      pendingPageScroll.current = scroll;
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output)");
      setMatchIndex(-1);
    } catch (error) {
      setPagerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPageBusy(false);
    }
  }

  async function fullBody(): Promise<string> {
    return source ? source.readAll() : body;
  }

  function flash(message: string, ms = 1800): void {
    setStatusFlash(message);
    setPagerError(undefined);
    setTimeout(() => setStatusFlash((cur) => (cur === message ? undefined : cur)), ms);
  }

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    let active = true;
    let scheduled = false;
    sb.verticalScrollBar.visible = false;
    sb.horizontalScrollBar.visible = false;
    const onResize = (): void => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!active) return;
        applyPendingPageScroll();
        pendingPageScroll.current = undefined;
        refreshScrollHint();
      });
    };
    sb.verticalScrollBar.on("change", refreshScrollHint);
    for (const event of PAGER_RESIZE_EVENTS) {
      sb.content.on(event, onResize);
      sb.viewport.on(event, onResize);
    }
    onResize();
    return () => {
      active = false;
      sb.verticalScrollBar.off("change", refreshScrollHint);
      for (const event of PAGER_RESIZE_EVENTS) {
        sb.content.off(event, onResize);
        sb.viewport.off(event, onResize);
      }
    };
  }, [continuous]);

  useEffect(() => {
    if (!hasQuery || matches.length === 0) {
      setMatchIndex(-1);
      return;
    }
    setMatchIndex((cur) => (cur >= matches.length ? -1 : cur));
  }, [hasQuery, matches]);

  function refreshScrollHint(): void {
    const sb = scrollRef.current;
    if (!sb) return;
    if (continuous) {
      const top = Math.max(0, sb.scrollTop);
      const height = Math.max(1, sb.viewport.height);
      setViewport((current) => current.top === top && current.height === height ? current : { top, height });
    }
    const max = Math.max(0, sb.scrollHeight - sb.viewport.height);
    if (max <= 0) {
      setScrollHint("all");
      return;
    }
    const ratio = sb.scrollTop / max;
    if (ratio <= 0.02) setScrollHint("top");
    else if (ratio >= 0.98) setScrollHint("bottom");
    else setScrollHint(`${Math.round(ratio * 100)}%`);
  }

  function scrollByRows(delta: number): void {
    const sb = scrollRef.current;
    if (!sb) return;
    const max = Math.max(0, sb.scrollHeight - sb.viewport.height);
    const next = Math.max(0, Math.min(max, sb.scrollTop + delta));
    if (following && delta < 0 && next < max) setFollowing(false);
    sb.scrollTo(next);
    refreshScrollHint();
  }

  function jumpToMatch(index: number, matchList: readonly PagerMatch[] = matches): void {
    if (index < 0 || matchList.length === 0) {
      setMatchIndex(-1);
      return;
    }
    setMatchIndex(index);
    const match = matchList[index];
    if (match) {
      setFollowing(false);
      queueMicrotask(() => {
        if (continuous) {
          const row = rowModels.findIndex((entry) =>
            entry.index === match.line && (entry.textOffset ?? 0) + entry.line.length > match.column,
          );
          scrollRef.current?.scrollTo(Math.max(0, row));
        } else {
          scrollRef.current?.scrollChildIntoView(`pager-line-${match.line}`);
        }
        refreshScrollHint();
      });
    }
  }

  async function submitSearch(): Promise<void> {
    if (source && !continuous && query.trim()) {
      setFollowing(false);
      setPageBusy(true);
      try {
        const page = await source.search(query.trim(), artifactPage?.offset ?? 0);
        if (page) {
          setArtifactPage(page);
          setDisplayBody(page.body);
          setMatchIndex(-1);
          setSearchOpen(false);
          queueMicrotask(() => scrollRef.current?.scrollTo(0));
        } else {
          setStatusFlash("no further matches");
        }
      } finally {
        setPageBusy(false);
      }
      return;
    }
    const found = findPagerMatches(searchLines, query);
    if (found.length === 0) return;
    const next = nextPagerMatch(found, matchIndex);
    jumpToMatch(next, found);
    setSearchOpen(false);
  }

  async function moveArtifactSearch(reverse: boolean): Promise<void> {
    if (!source || !query.trim() || pageBusy) return;
    setPageBusy(true);
    try {
      const from = reverse ? artifactPage?.offset ?? 0 : artifactPage?.nextOffset ?? 0;
      const page = await source.search(query.trim(), from, reverse);
      if (!page) {
        setStatusFlash(reverse ? "no previous matches" : "no further matches");
        return;
      }
      setArtifactPage(page);
      setDisplayBody(page.body);
      setMatchIndex(-1);
      queueMicrotask(() => scrollRef.current?.scrollTo(0));
    } finally {
      setPageBusy(false);
    }
  }

  function clearSearch(): void {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(-1);
  }

  useKeyboard((key) => {
    if (key.defaultPrevented || key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    pendingPageScroll.current = undefined;

    if (searchOpen) {
      if (chord === "escape") {
        key.preventDefault();
        clearSearch();
      }
      return;
    }

    const action = services.router.resolve(chord, "pager");
    if (!action) {
      if (chord === "escape" && hasQuery) {
        key.preventDefault();
        clearSearch();
      }
      return;
    }
    key.preventDefault();
    const sb = scrollRef.current;
    switch (action) {
      case "pager.line-up":
        scrollByRows(-1);
        break;
      case "pager.line-down":
        scrollByRows(1);
        break;
      case "pager.page-up":
        if (source && artifactPage && (sb?.scrollTop ?? 0) <= 0 && artifactPage.offset > 0) {
          void loadArtifactPage(Math.max(0, artifactPage.offset - source.pageBytes));
        } else {
          scrollByRows(-(sb?.viewport.height ?? 10));
        }
        break;
      case "pager.page-down": {
        const atBottom = !sb || sb.scrollTop >= Math.max(0, sb.scrollHeight - sb.viewport.height);
        if (source && artifactPage && atBottom && artifactPage.nextOffset < artifactPage.totalBytes) {
          void loadArtifactPage(artifactPage.nextOffset);
        } else {
          scrollByRows(sb?.viewport.height ?? 10);
        }
        break;
      }
      case "pager.half-page-up":
        scrollByRows(-Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.half-page-down":
        scrollByRows(Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.top":
        setFollowing(false);
        if (source && artifactPage?.offset) {
          void loadArtifactPage(0, "top");
        } else {
          sb?.scrollTo(0);
        }
        refreshScrollHint();
        break;
      case "pager.bottom":
        if (source && artifactPage && artifactPage.nextOffset < artifactPage.totalBytes) {
          void loadArtifactPage(
            Math.max(0, artifactPage.totalBytes - source.pageBytes),
            "bottom",
          );
        } else {
          const max = sb
            ? Math.max(0, sb.scrollHeight - (sb.viewport?.height ?? 0))
            : 0;
          sb?.scrollTo(max);
        }
        refreshScrollHint();
        break;
      case "pager.search":
        setSearchOpen(true);
        break;
      case "pager.next-match":
        if (source && !continuous && hasQuery) void moveArtifactSearch(false);
        else if (matches.length > 0) jumpToMatch(nextPagerMatch(matches, matchIndex));
        break;
      case "pager.prev-match":
        if (source && !continuous && hasQuery) void moveArtifactSearch(true);
        else if (matches.length > 0) jumpToMatch(prevPagerMatch(matches, matchIndex));
        break;
      case "pager.copy":
        void fullBody()
          .then((full) => services.ports.clipboard.writeText(bodyOnlyForCopy(full)))
          .then(
            () => {
              flash("copied all");
              services.toast.success("Copied pager body", {
                key: "clipboard",
                durationMs: 1500,
              });
            },
            () => {
              flash("copy failed");
              services.toast.error("Copy failed", { key: "clipboard" });
            },
          );
        break;
      case "pager.format":
        setViewMode("formatted");
        setMatchIndex(-1);
        flash("view: formatted (markdown)");
        queueMicrotask(() => scrollRef.current?.scrollTo(0));
        break;
      case "pager.raw":
        setViewMode("raw");
        setMatchIndex(-1);
        flash("view: raw");
        queueMicrotask(() => scrollRef.current?.scrollTo(0));
        break;
      case "pager.toggle-follow":
        if (!canFollow) {
          flash("this view has no live source");
          break;
        }
        setFollowing((current) => {
          const next = !current;
          flash(next ? "following live output" : "follow paused");
          return next;
        });
        break;
      case "pager.close":
        if (hasQuery) {
          clearSearch();
        } else {
          services.overlay.close();
        }
        break;
      default:
        break;
    }
  });

  const scrollLabel =
    scrollHint === "all"
      ? "all"
      : scrollHint === "top"
        ? "top"
        : scrollHint === "bottom"
          ? "bottom"
          : scrollHint;

  const matchStatus =
    hasQuery && matches.length > 0
      ? `${Math.max(0, matchIndex) + 1}/${matches.length}`
      : hasQuery
        ? "no matches"
        : "";

  const lineCountRight = artifactPage && !continuous
    ? `${lines.length} lines · page ${artifactPage.pageNumber}/${artifactPage.pageCount}${pageBusy ? " · loading" : ""}`
    : `${lines.length} lines · ${scrollLabel}`;

  const metaLeft = hasQuery
    ? fitOneLine(
        [
          `find:${query.trim()} ${matchStatus}`,
          `find:${matchStatus}`,
          matchStatus || "find",
        ],
        Math.max(8, Math.floor(chromeCols * 0.65)),
      )
    : fitOneLine(
        [
          PAGER_HELP_FULL,
          PAGER_HELP_MED,
          PAGER_HELP_SHORT,
          PAGER_HELP_MIN,
          "^r:search · q:close",
        ],
        Math.max(8, Math.floor(chromeCols * 0.65)),
      );

  const metaLine = padChromeRow(metaLeft, lineCountRight, chromeCols);

  const viewLabel = viewMode === "formatted" ? "fmt" : "raw";
  const growing = source?.isGrowing?.() ?? false;
  const followLabel = growing
    ? following ? "● following" : "❙❙ paused (running)"
    : "finished";
  const footerLeft = pagerError
    ? `pager error: ${pagerError}`
    : statusFlash
      ? statusFlash
      : hasQuery
        ? "n/N:next  ·  esc:clear-find  ·  q:close"
        : canFollow
          ? fitOneLine(
              [
                `l:${following ? "pause" : "follow"}  ·  ${followLabel}  ·  c:copy`,
                `l:follow  ·  ${followLabel}`,
                followLabel,
              ],
              Math.max(12, Math.floor(chromeCols * 0.78)),
            )
          : fitOneLine(
            [
              `f:format  ·  r:raw  ·  view:${viewLabel}  ·  c:copy`,
              `f:fmt  ·  r:raw  ·  ${viewLabel}`,
              PAGER_FOOTER_SHORT,
              PAGER_FOOTER_FULL,
            ],
            Math.max(12, Math.floor(chromeCols * 0.78)),
          );
  const footerLine = padChromeRow(footerLeft, scrollLabel, chromeCols);

  const filterHint = fitOneLine(
    [
      matches.length > 0
        ? `${matchStatus}  ·  enter:jump  ·  esc:close`
        : query.trim()
          ? "no matches · esc:close"
          : "type to search  ·  esc:close",
      matches.length > 0 ? `${matchStatus} · enter · esc:close` : "esc:close",
      matches.length > 0 ? matchStatus : "esc",
    ],
    Math.max(8, Math.floor(chromeCols * 0.4)),
  );

  const lineSearch = useMemo(() => groupPagerMatches(matches, matchIndex), [matches, matchIndex]);

  const bodyRows = useMemo(
    () =>
      rowModels.slice(rowWindow.start, rowWindow.end).map((row) => {
        const offset = row.textOffset ?? 0;
        const search = continuous
          ? pagerRowSearch(lineSearch.get(row.index), offset, row.line.length)
          : lineSearch.get(row.index);
        const styled = row.kind === "markdown" ? display.lines[row.index]?.styled : undefined;
        const spans = row.kind === "markdown" || row.kind === "subagent" ? subagentSpans?.[row.index] : undefined;
        const line = (
          <PagerLine
            key={row.key}
            line={row.line}
            index={row.index}
            theme={theme}
            matches={search?.matches ?? NO_MATCHES}
            activeMatchIndex={search?.active ?? -1}
            hasQuery={hasQuery}
            highlightPath={row.kind === "markdown" ? "" : pathForHighlight}
            spans={row.spans}
            styled={continuous && styled ? new StyledText(slicePagerSpans(styled.chunks, offset, row.line.length)) : styled}
            markdownMode={row.kind === "markdown" ? true : undefined}
            diffGutters={row.kind === "plain" || row.kind === "subagent" ? false : undefined}
            subagent={row.kind === "diff" ? undefined : row.kind === "subagent" || isSubagent}
            subagentSpans={continuous && spans ? slicePagerSpans(spans, offset, row.line.length) : spans}
          />
        );
        return continuous ? <box key={row.key} style={{ height: 1, flexShrink: 0, width: "100%" }}>{line}</box> : line;
      }),
    [rowModels, rowWindow.start, rowWindow.end, lineSearch, theme, hasQuery, pathForHighlight, display.lines, isSubagent, subagentSpans, continuous],
  );

  const borderTitle = ` ${fitOneLine([sanitizeDisplayText(title)], Math.max(1, size.width - 4))} `;

  return (
    <box
      border={border}
      borderStyle="rounded"
      title={borderTitle}
      titleAlignment="left"
      titleColor={theme.cyan}
      style={{
        flexDirection: "column",
        width: size.width,
        height: size.height,
        borderColor: theme.border,
        backgroundColor: theme.statusBackground,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {innerH >= 3 ? <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: padding,
          paddingRight: padding,
        }}
      >
        {searchOpen ? (
          <box
            style={{
              flexDirection: "row",
              flexGrow: 1,
              flexShrink: 1,
              width: "100%",
              height: 1,
              minWidth: 0,
            }}
          >
            <text
              selectable={false}
              content=" ^R "
              style={{
                fg: theme.background,
                bg: theme.cyan,
                attributes: TextAttributes.BOLD,
                height: 1,
              }}
            />
            <text selectable={false} content=" " style={{ height: 1 }} />
            <input
              focused
              value={query}
              onInput={(value) => {
                setQuery(value);
                setMatchIndex(-1);
              }}
              onSubmit={submitSearch}
              textColor={theme.foreground}
              backgroundColor={theme.rowB}
              style={{ flexGrow: 1, minWidth: 0 }}
            />
            <text
              selectable={false}
              content={fitOneLine([` ${filterHint}`], Math.max(8, Math.floor(chromeCols * 0.35)))}
              style={{ fg: theme.muted, flexShrink: 0, height: 1 }}
            />
          </box>
        ) : (
          <text
            selectable={false}
            content={metaLine}
            style={{ fg: theme.muted, height: 1, width: "100%" }}
          />
        )}
      </box> : null}

      <scrollbox
        ref={scrollRef}
        viewportCulling
        scrollY
        scrollX={false}
        stickyScroll={following}
        stickyStart="bottom"
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          width: "100%",
          minHeight: 1,
          backgroundColor: theme.background,
          marginTop: 0,
          marginBottom: 0,
          paddingLeft: padding,
          paddingRight: padding,
          paddingTop: 0,
        }}
        onMouseScroll={(event) => {
          if (following && event.scroll?.direction === "up") setFollowing(false);
          refreshScrollHint();
        }}
      >
        {continuous ? <box key="before" style={{ height: rowWindow.start, flexShrink: 0 }} /> : null}
        {bodyRows}
        {continuous ? <box key="after" style={{ height: rowModels.length - rowWindow.end, flexShrink: 0 }} /> : null}
      </scrollbox>

      {innerH >= 2 ? <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: padding,
          paddingRight: padding,
        }}
      >
        <text
          selectable={false}
          content={footerLine}
          style={{
            fg: pagerError ? theme.mode : theme.muted,
            height: 1,
            width: "100%",
          }}
        />
      </box> : null}
    </box>
  );
}
