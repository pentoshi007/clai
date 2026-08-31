/** @jsxImportSource @opentui/react */
/**
 * Scrollable pager for long content — full tool output, plan detail (PICK-003,
 * V2-074).
 *
 * Clean chrome: one border title, one meta/help row, body, one footer.
 * Ctrl+R search: substring matches paint reverse-video; Enter jumps to the
 * next hit and keeps the query so n/N / highlight stay active after the
 * filter bar closes.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
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
  wrapPagerLine,
} from "../../../ui-core/rendering/pager-chrome.js";
import {
  emptyCarry,
} from "../../../ui-core/rendering/syntax-highlight.js";
import {
  preparePagerDisplay,
  type PagerMarkdownMode,
} from "../../rendering/pager-markdown.js";
import {
  extractFsReadFileBody,
  stripPagerLineGutters,
} from "../../../ui-core/rendering/pager-source.js";
import {
  PagerLine,
  bodyOnlyForCopy,
  parseDiffLine,
} from "./pager-line.js";

export interface PagerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly title: string;
  readonly body: string;
  readonly source?: ArtifactPagerSource | undefined;
  /** When set, syntax-highlight diff bodies using this path's language. */
  readonly highlightPath?: string | undefined;
  /**
   * Initial markdown mode. Help/shortcuts/plan pass `force` (start formatted).
   * Tool dumps default `auto` (start raw; press `f` for formatted, `r` for raw).
   */
  readonly markdown?: PagerMarkdownMode | undefined;
}

/** User-toggleable body view in the pager. */
type PagerViewMode = "formatted" | "raw";

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

/** Progressive help lines — always one row; never wrap into the line-count. */
const PAGER_HELP_FULL =
  "↑↓:scroll  ·  pg↑↓:page  ·  ^r:search  ·  n/N:next  ·  f:format  ·  r:raw  ·  c:copy  ·  s:scrollback  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_MED =
  "↑↓:scroll  ·  ^r:search  ·  f:format  ·  r:raw  ·  c:copy  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_SHORT =
  "↑↓:scroll  ·  ^r:search  ·  f:format  ·  r:raw  ·  c:copy  ·  q/esc:close";
const PAGER_HELP_MIN = "^r:search  ·  q/esc:close";

const PAGER_FOOTER_FULL =
  "f:format  ·  r:raw  ·  c:copy  ·  drag:select  ·  s:scrollback  ·  e:editor";
const PAGER_FOOTER_SHORT = "f:format  ·  r:raw  ·  c:copy  ·  s:scrollback  ·  e:editor";

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
  const { width: termWidth } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [displayBody, setDisplayBody] = useState(body);
  const [artifactPage, setArtifactPage] = useState<ArtifactPage | undefined>(undefined);
  const [pageBusy, setPageBusy] = useState(false);
  // Help/plan start formatted; everything else starts raw — user presses f/r.
  const [viewMode, setViewMode] = useState<PagerViewMode>(() =>
    markdown === "force" ? "formatted" : "raw",
  );
  // Conservative width: 96% box sits inside app chrome; overestimate caused
  // "11 lines" to paint past the rounded border after search.
  const pagerOuterCols = Math.max(40, Math.floor(termWidth * 0.96));
  const contentCols = Math.max(24, pagerOuterCols - 10);
  // Meta/footer rows (with their padding) — exact column budget for padChromeRow.
  const chromeCols = Math.max(20, contentCols - 4);

  // f → strip line-number gutters / fs.read `N: ` + force markdown.
  // r → always the original body (never the post-markdown plain extract).
  const display = useMemo(() => {
    if (viewMode === "formatted") {
      const stripped = stripPagerLineGutters(displayBody);
      const clean =
        /^\d+:\s?/m.test(displayBody) || /^#\s*fs\.read\b/m.test(displayBody)
          ? extractFsReadFileBody(displayBody) || stripped
          : stripped;
      return preparePagerDisplay({
        body: clean,
        width: contentCols,
        mode: "force",
        defaultFg: theme.foreground,
        theme,
        colorMode,
      });
    }
    return preparePagerDisplay({
      body: displayBody,
      width: contentCols,
      mode: "plain",
      defaultFg: theme.foreground,
      theme,
      colorMode,
    });
  }, [displayBody, contentCols, viewMode, theme, colorMode]);

  const lines = useMemo(
    () => display.lines.map((l) => l.plain),
    [display.lines],
  );
  // Syntax gutters only for raw file/diff viewers — never for markdown format.
  const pathForHighlight =
    viewMode === "raw" && highlightPath ? highlightPath : title;
  const useDiffGutters =
    viewMode === "raw" && Boolean(highlightPath) && display.mode === "plain";
  // Search haystack:
  // - markdown: full plain lines (never strip "│" as a diff gutter)
  // - raw file-diff: code only so gutters are not matched
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
  const [following, setFollowing] = useState(canFollow);
  const matches = useMemo(
    () => findPagerMatches(searchLines, query),
    [searchLines, query],
  );
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [statusFlash, setStatusFlash] = useState<string | undefined>(undefined);
  const hasQuery = query.trim().length > 0;
  // Stable carry for syntax across the visible line list (recreated when body changes).
  const syntaxCarry = useMemo(() => emptyCarry(), [displayBody, pathForHighlight]);

  useEffect(() => {
    if (!source) {
      setDisplayBody(body);
      setArtifactPage(undefined);
      return;
    }
    let active = true;
    setPageBusy(true);
    // A followable source opens on its last page so the newest output is
    // on screen immediately, exactly like `tail -f`.
    const first = canFollow && source.readTail ? source.readTail() : source.readPage(0);
    void first.then((page) => {
      if (!active) return;
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output yet)");
      if (canFollow) {
        queueMicrotask(() => {
          const box = scrollRef.current;
          if (!box) return;
          box.scrollTo(Math.max(0, box.scrollHeight - (box.viewport?.height ?? 0)));
        });
      }
    }).catch((error) => {
      if (active) setExportError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setPageBusy(false); });
    return () => { active = false; };
  }, [body, source, canFollow]);

  // Follow mode. Driven purely by the source's change notifications (already
  // coalesced upstream), so there is no polling timer and at most one bounded
  // page read per notification. Stops itself when the producer finishes.
  useEffect(() => {
    if (!source?.watch || !following) return;
    let active = true;
    let reading = false;
    const pull = (): void => {
      if (!active || reading || !source.readTail) return;
      reading = true;
      void source
        .readTail()
        .then((page) => {
          if (!active) return;
          setArtifactPage(page);
          setDisplayBody(page.body || "(no output yet)");
          queueMicrotask(() => {
            const box = scrollRef.current;
            if (!box) return;
            box.scrollTo(Math.max(0, box.scrollHeight - (box.viewport?.height ?? 0)));
            refreshScrollHint();
          });
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
        });
    };
    const unwatch = source.watch(pull);
    pull();
    return () => {
      active = false;
      unwatch();
    };
  }, [source, following]);

  // Leaving follow mode automatically once the job is finished keeps the
  // footer honest instead of advertising a feed that can no longer move.
  useEffect(() => {
    if (!following || !source?.isGrowing) return;
    if (!source.isGrowing()) setFollowing(false);
  }, [following, source, artifactPage]);

  async function loadArtifactPage(
    offset: number,
    scroll: "top" | "bottom" = "top",
  ): Promise<void> {
    if (!source || pageBusy) return;
    setPageBusy(true);
    try {
      const page = await source.readPage(offset);
      setArtifactPage(page);
      setDisplayBody(page.body || "(no output)");
      setMatchIndex(-1);
      queueMicrotask(() => {
        const box = scrollRef.current;
        if (!box) return;
        if (scroll === "bottom") {
          const max = Math.max(0, box.scrollHeight - (box.viewport?.height ?? 0));
          box.scrollTo(max);
        } else {
          box.scrollTo(0);
        }
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setPageBusy(false);
    }
  }

  async function fullBody(): Promise<string> {
    return source ? source.readAll() : body;
  }

  function flash(message: string, ms = 1800): void {
    setStatusFlash(message);
    setExportError(undefined);
    setTimeout(() => setStatusFlash((cur) => (cur === message ? undefined : cur)), ms);
  }

  // Force-hide both bars — the grey horizontal track was the ugly bottom band.
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    sb.verticalScrollBar.visible = false;
    sb.horizontalScrollBar.visible = false;
  }, [lines.length]);

  // Drop an out-of-range active index when the query shrinks the hit list.
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
    // Scrolling away from the end means the user wants to read history, so
    // stop yanking the viewport back to the newest bytes. Returning to the
    // bottom resumes following.
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
      // Defer until after paint so the active line exists in the scroll tree.
      queueMicrotask(() => {
        scrollRef.current?.scrollChildIntoView(`pager-line-${match.line}`);
        refreshScrollHint();
      });
    }
  }

  /** Enter / submit: next hit from the *current* query (avoids stale closure). */
  async function submitSearch(): Promise<void> {
    if (source && query.trim()) {
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
    const found = findPagerMatches(lines, query);
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

  async function runExport(
    promise: Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string },
    okMessage: string,
  ): Promise<void> {
    try {
      const result = await promise;
      if (result.ok) {
        flash(okMessage, 2400);
        setExportError(undefined);
      } else {
        setExportError(result.error ?? "export failed");
        setStatusFlash(undefined);
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
      setStatusFlash(undefined);
    }
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);

    if (searchOpen) {
      if (chord === "escape") {
        key.preventDefault();
        // Abort filter: drop query + highlights.
        clearSearch();
      }
      // Let the <input> consume other keys (including Enter → onSubmit).
      return;
    }

    const action = services.router.resolve(chord, "pager");
    if (!action) {
      // Esc with an active query clears highlight without closing the pager.
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
        // g — absolute start (first artifact page + scroll top).
        if (source && artifactPage?.offset) {
          void loadArtifactPage(0, "top");
        } else {
          sb?.scrollTo(0);
        }
        refreshScrollHint();
        break;
      case "pager.bottom":
        // G — absolute end (last artifact page + scroll bottom).
        if (source && artifactPage && artifactPage.pageNumber < artifactPage.pageCount) {
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
        if (source && hasQuery) void moveArtifactSearch(false);
        else if (matches.length > 0) jumpToMatch(nextPagerMatch(matches, matchIndex));
        break;
      case "pager.prev-match":
        if (source && hasQuery) void moveArtifactSearch(true);
        else if (matches.length > 0) jumpToMatch(prevPagerMatch(matches, matchIndex));
        break;
      case "pager.export-scrollback":
        void fullBody().then((full) => runExport(
          services.pagerExport.exportToScrollback(title, full),
          "exported to terminal scrollback (scroll up after exit)",
        )).catch((error) => setExportError(error instanceof Error ? error.message : String(error)));
        break;
      case "pager.export-editor":
        void fullBody().then((full) => runExport(services.pagerExport.exportToEditor(full), "opened in editor"))
          .catch((error) => setExportError(error instanceof Error ? error.message : String(error)));
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
        // First Esc clears an active search highlight; second closes the pager.
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

  const lineCountRight = artifactPage
    ? `${lines.length} lines · page ${artifactPage.pageNumber}/${artifactPage.pageCount}${pageBusy ? " · loading" : ""}`
    : `${lines.length} lines · ${scrollLabel}`;

  // While a find is active, prefer find status over the long help line so the
  // right-side line count always has room.
  const metaLeft = hasQuery
    ? fitOneLine(
        [
          statusFlash
            ? `${statusFlash}  ·  find:${query.trim()} ${matchStatus}`
            : `find:${query.trim()} ${matchStatus}`,
          `find:${matchStatus}`,
          matchStatus || "find",
        ],
        Math.max(8, Math.floor(chromeCols * 0.65)),
      )
    : fitOneLine(
        [
          statusFlash
            ? `${PAGER_HELP_SHORT}  ·  ${statusFlash}`
            : PAGER_HELP_FULL,
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
  const followLabel = following
    ? "● following"
    : growing
      ? "❙❙ paused (running)"
      : "finished";
  const footerLeft = exportError
    ? `export failed: ${exportError}`
    : statusFlash
      ? statusFlash
      : hasQuery
        ? "n/N:next  ·  esc:clear-find  ·  q:close"
        : canFollow
          ? fitOneLine(
              [
                `l:${following ? "pause" : "follow"}  ·  ${followLabel}  ·  c:copy  ·  s:scrollback  ·  e:editor`,
                `l:${following ? "pause" : "follow"}  ·  ${followLabel}  ·  c:copy  ·  e:editor`,
                `l:${following ? "pause" : "follow"}  ·  ${followLabel}  ·  c:copy`,
                `l:follow  ·  ${followLabel}`,
                followLabel,
              ],
              Math.max(12, Math.floor(chromeCols * 0.78)),
            )
          : fitOneLine(
            [
              `f:format  ·  r:raw  ·  view:${viewLabel}  ·  c:copy  ·  s:scrollback  ·  e:editor`,
              `f:format  ·  r:raw  ·  view:${viewLabel}  ·  c:copy  ·  e:editor`,
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

  // Scroll position only changes pager chrome. Keep the complete row array
  // referentially stable so wheel/key events never repeat grapheme wrapping or
  // reconcile every off-screen PagerLine; viewportCulling handles native paint.
  const bodyRows = useMemo(
    () =>
      lines.flatMap((line, index) => {
        const row = display.lines[index];
        const isMd = display.mode === "markdown";

        // Markdown lines are already width-wrapped by renderMarkdown; paint
        // one StyledText row each (search falls back to plain segments).
        if (isMd) {
          return [
            <PagerLine
              key={`md-${index}-0`}
              line={line}
              index={index}
              theme={theme}
              matches={matches}
              activeMatchIndex={matchIndex}
              hasQuery={hasQuery}
              highlightPath=""
              carry={syntaxCarry}
              styled={row?.styled}
              markdownMode
            />,
          ];
        }

        // Diff gutters only in raw file-viewer mode — never eat compacted
        // / help text that happens to contain " │ ".
        const parsed = useDiffGutters ? parseDiffLine(line) : null;
        if (parsed) {
          // Soft-wrap code only; keep internal mark so parseDiffLine still
          // knows add/del tone. PagerLine does not paint +/-.
          const codeChunks = wrapPagerLine(
            parsed.code,
            Math.max(12, contentCols - (parsed.gutter.length + 3)),
          );
          return codeChunks.map((codeChunk, part) => {
            const mark =
              parsed.tone === "add"
                ? "+"
                : parsed.tone === "del"
                  ? "−"
                  : " ";
            const g =
              part === 0
                ? parsed.gutter
                : " ".repeat(parsed.gutter.length);
            const rebuilt =
              parsed.tone === "header"
                ? `${g} │ ${codeChunk}`
                : `${g} │ ${mark} ${codeChunk}`;
            return (
              <PagerLine
                key={`${index}-${part}`}
                line={rebuilt}
                index={index}
                theme={theme}
                matches={matches}
                activeMatchIndex={matchIndex}
                hasQuery={hasQuery}
                highlightPath={pathForHighlight}
                carry={syntaxCarry}
              />
            );
          });
        }
        return wrapPagerLine(line, contentCols).map((chunk, part) => (
          <PagerLine
            key={`${index}-${part}`}
            line={chunk}
            index={index}
            theme={theme}
            matches={matches}
            activeMatchIndex={matchIndex}
            hasQuery={hasQuery}
            highlightPath={pathForHighlight}
            carry={syntaxCarry}
          />
        ));
      }),
    [
      contentCols,
      display,
      hasQuery,
      lines,
      matchIndex,
      matches,
      pathForHighlight,
      syntaxCarry,
      theme,
      useDiffGutters,
    ],
  );

  // Clip long titles so the border doesn't wrap/overflow.
  const borderTitle =
    title.length > 72 ? ` ${title.slice(0, 69)}… ` : ` ${title} `;

  return (
    <box
      border
      borderStyle="rounded"
      title={borderTitle}
      titleAlignment="left"
      titleColor={theme.cyan}
      style={{
        flexDirection: "column",
        // Larger than before — fills most of the terminal.
        width: "96%",
        height: "92%",
        borderColor: theme.border,
        backgroundColor: theme.statusBackground,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      {/* Single fixed-width meta row — never flex-overflow past the border. */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
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
                // Reset so Enter always lands on the first hit for a new query.
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
      </box>

      <scrollbox
        ref={scrollRef}
        viewportCulling
        scrollY
        scrollX={false}
        stickyScroll={false}
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          width: "100%",
          minHeight: 8,
          backgroundColor: theme.background,
          marginTop: 0,
          marginBottom: 0,
          paddingLeft: 1,
          paddingRight: 1,
          // File-diff modals stay dense; format / plain keep a little air.
          paddingTop: useDiffGutters ? 0 : 1,
        }}
        onMouseScroll={() => refreshScrollHint()}
      >
        {!useDiffGutters ? (
          // Full-width opaque spacer — a one-cell row leaves the rest of the
          // line unpainted, so scrolled-away glyphs survive at the edge.
          <text
            content=" "
            style={{ height: 1, width: "100%", bg: theme.background }}
          />
        ) : null}
        {bodyRows}
        {!useDiffGutters ? (
          <text
            content=" "
            style={{ height: 1, width: "100%", bg: theme.background }}
          />
        ) : null}
      </scrollbox>

      {/* Fixed-width footer row (same padChromeRow budget as meta). */}
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text
          selectable={false}
          content={footerLine}
          style={{
            fg: exportError ? theme.mode : theme.muted,
            height: 1,
            width: "100%",
          }}
        />
      </box>
    </box>
  );
}
