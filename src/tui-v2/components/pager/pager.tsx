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
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import {
  findPagerMatches,
  nextPagerMatch,
  prevPagerMatch,
  segmentPagerLine,
  type PagerMatch,
} from "../../state/pager-search.js";

export interface PagerProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly title: string;
  readonly body: string;
}

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

/** Progressive help lines — always one row; never wrap into the line-count. */
const PAGER_HELP_FULL =
  "↑↓:scroll  ·  pg↑↓:page  ·  g/G:jump  ·  ^r:search  ·  n/N:next  ·  c:copy  ·  s:scrollback  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_MED =
  "↑↓:scroll  ·  ^r:search  ·  n/N:next  ·  c:copy  ·  e:editor  ·  q/esc:close";
const PAGER_HELP_SHORT = "↑↓:scroll  ·  ^r:search  ·  c:copy  ·  q/esc:close";
const PAGER_HELP_MIN = "↑↓  ·  ^r  ·  q/esc:close";

const PAGER_FOOTER_FULL =
  "c:copy  ·  drag:select  ·  s/^s:scrollback  ·  e/^e:editor";
const PAGER_FOOTER_SHORT = "c:copy  ·  s:scrollback  ·  e:editor";

function fitOneLine(candidates: readonly string[], maxCols: number): string {
  const budget = Math.max(8, maxCols);
  for (const text of candidates) {
    if (text.length <= budget) return text;
  }
  const last = candidates[candidates.length - 1] ?? "";
  if (last.length <= budget) return last;
  if (budget <= 1) return "…";
  return `${last.slice(0, budget - 1)}…`;
}

/** Base fg for a non-match body line (path/header cues, plan sections). */
function baseLineFg(line: string, theme: Theme): string {
  const t = line.trim();
  if (/^──\s*full output saved at/i.test(t)) return theme.response;
  if (/^\/Users\/|^\/home\/|^~\/|^\.clai\/|outputs\//i.test(t)) {
    return theme.response;
  }
  if (t.startsWith("─")) return theme.chip;
  // Plan pager section titles
  if (/^(Approach|Tasks|Goal|Status)\b/i.test(t) && !t.includes("  ·")) {
    return theme.cyan;
  }
  if (/^Status\s+/i.test(t) || /^Updated\s+/i.test(t)) return theme.muted;
  if (/^[✓✗○◉–]\s/.test(t) || /^\s+[✓✗○◉–]\s/.test(line)) {
    if (t.startsWith("✓") || line.includes("  ✓")) return theme.success;
    if (t.startsWith("✗") || line.includes("  ✗")) return theme.accent;
    if (t.startsWith("◉") || line.includes("  ◉")) return theme.activity;
    return theme.muted;
  }
  if (/^(Next:|Plan is approved|All tasks completed)/i.test(t)) return theme.muted;
  if (/q\/esc:close|Esc or q to close/i.test(t)) return theme.muted;
  return theme.foreground;
}

function PagerLine(props: {
  line: string;
  index: number;
  theme: Theme;
  matches: readonly PagerMatch[];
  activeMatchIndex: number;
  hasQuery: boolean;
}): ReactNode {
  const { line, index, theme, matches, activeMatchIndex, hasQuery } = props;
  const baseFg = baseLineFg(line, theme);
  const isActiveLine =
    hasQuery &&
    activeMatchIndex >= 0 &&
    matches[activeMatchIndex]?.line === index;

  if (!hasQuery || matches.length === 0) {
    return (
      <text
        id={`pager-line-${index}`}
        selectable
        style={{
          fg: baseFg,
          // Subtle bar on the active match line so the jump target is obvious.
          ...(isActiveLine ? { bg: theme.rowA } : {}),
        }}
      >
        {line || " "}
      </text>
    );
  }

  const segments = segmentPagerLine(line, index, matches, activeMatchIndex);
  return (
    <text
      id={`pager-line-${index}`}
      selectable
      style={{
        fg: baseFg,
        ...(isActiveLine ? { bg: theme.rowA } : {}),
      }}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return (
            <span key={i} style={{ fg: baseFg }}>
              {seg.text}
            </span>
          );
        }
        if (seg.kind === "active") {
          // Current hit: bright reverse-video yellow.
          return (
            <span
              key={i}
              style={{
                fg: theme.background,
                bg: theme.activity,
                attributes: TextAttributes.BOLD,
              }}
            >
              {seg.text}
            </span>
          );
        }
        // Other hits: blue selection chip.
        return (
          <span
            key={i}
            style={{
              fg: theme.white,
              bg: theme.selection,
              attributes: TextAttributes.BOLD,
            }}
          >
            {seg.text}
          </span>
        );
      })}
    </text>
  );
}

export function Pager(props: PagerProps): ReactNode {
  const { services, theme, title, body } = props;
  const { width: termWidth } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const lines = useMemo(() => body.replace(/\n+$/, "").split("\n"), [body]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [scrollHint, setScrollHint] = useState("top");
  const matches = useMemo(() => findPagerMatches(lines, query), [lines, query]);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [statusFlash, setStatusFlash] = useState<string | undefined>(undefined);
  const hasQuery = query.trim().length > 0;

  // Pager is ~96% wide with padding; reserve room for " N lines · bottom ".
  const contentCols = Math.max(24, Math.floor(termWidth * 0.96) - 8);

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
    sb.scrollTo(Math.max(0, Math.min(max, sb.scrollTop + delta)));
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
  function submitSearch(): void {
    const found = findPagerMatches(lines, query);
    if (found.length === 0) return;
    const next = nextPagerMatch(found, matchIndex);
    jumpToMatch(next, found);
    // Close the filter bar but keep the query so highlights + n/N remain.
    setSearchOpen(false);
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
        scrollByRows(-(sb?.viewport.height ?? 10));
        break;
      case "pager.page-down":
        scrollByRows(sb?.viewport.height ?? 10);
        break;
      case "pager.half-page-up":
        scrollByRows(-Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.half-page-down":
        scrollByRows(Math.max(1, Math.floor((sb?.viewport.height ?? 10) / 2)));
        break;
      case "pager.top":
        sb?.scrollTo(0);
        refreshScrollHint();
        break;
      case "pager.bottom":
        sb?.scrollTo(sb.scrollHeight);
        refreshScrollHint();
        break;
      case "pager.search":
        setSearchOpen(true);
        break;
      case "pager.next-match":
        if (matches.length > 0) jumpToMatch(nextPagerMatch(matches, matchIndex));
        break;
      case "pager.prev-match":
        if (matches.length > 0) jumpToMatch(prevPagerMatch(matches, matchIndex));
        break;
      case "pager.export-scrollback":
        void runExport(
          services.pagerExport.exportToScrollback(title, body),
          "exported to terminal scrollback (scroll up after exit)",
        );
        break;
      case "pager.export-editor":
        void runExport(services.pagerExport.exportToEditor(body), "opened in editor");
        break;
      case "pager.copy":
        void services.ports.clipboard.writeText(body).then(
          () => flash("copied all"),
          () => flash("copy failed"),
        );
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

  const lineCountText = `${lines.length} lines · ${scrollLabel}`;
  // Leave room for the right-side status so help never wraps under it.
  const helpBudget = Math.max(12, contentCols - lineCountText.length - 3);
  const findSuffix =
    hasQuery && matchStatus ? `  ·  find:${query.trim()} ${matchStatus}` : "";
  const flashSuffix = statusFlash ? `  ·  ${statusFlash}` : "";
  const helpCore = fitOneLine(
    [PAGER_HELP_FULL, PAGER_HELP_MED, PAGER_HELP_SHORT, PAGER_HELP_MIN],
    Math.max(12, helpBudget - findSuffix.length - flashSuffix.length),
  );
  const helpText = fitOneLine(
    [`${helpCore}${flashSuffix}${findSuffix}`],
    helpBudget,
  );
  const footerLeft = exportError
    ? fitOneLine([`export failed: ${exportError}`], helpBudget)
    : statusFlash
      ? fitOneLine([statusFlash], helpBudget)
      : hasQuery
        ? fitOneLine(["n/N:next  ·  esc:clear-find  ·  q:close"], helpBudget)
        : fitOneLine([PAGER_FOOTER_FULL, PAGER_FOOTER_SHORT], helpBudget);

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
      {/* Single-height meta row: help (truncated) left · line count right. */}
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
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
            <text selectable={false} style={{ fg: theme.cyan, height: 1 }}>
              filter:{" "}
            </text>
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
              style={{ flexGrow: 1 }}
            />
            <text selectable={false} style={{ fg: theme.muted, flexShrink: 0 }}>
              {" "}
              {matches.length > 0
                ? `${matchStatus}  ·  enter:next  ·  esc:cancel`
                : query.trim()
                  ? "no matches"
                  : "type:filter"}
            </text>
          </box>
        ) : (
          <>
            <box
              style={{
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                height: 1,
              }}
            >
              <text
                selectable={false}
                content={helpText}
                style={{ fg: theme.muted, height: 1 }}
              />
            </box>
            <text
              selectable={false}
              content={` ${lineCountText}`}
              style={{ fg: theme.cyan, height: 1, flexShrink: 0 }}
            />
          </>
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
          paddingTop: 1,
        }}
        onMouseScroll={() => refreshScrollHint()}
      >
        {/* Leading blank for top breathing room */}
        <text content=" " style={{ height: 1 }} />
        {lines.map((line, index) => (
          <PagerLine
            key={index}
            line={line}
            index={index}
            theme={theme}
            matches={matches}
            activeMatchIndex={matchIndex}
            hasQuery={hasQuery}
          />
        ))}
        <text content=" " style={{ height: 1 }} />
      </scrollbox>

      {/* Slim footer — single line; left truncates, right stays fixed. */}
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: 1 }}>
          <text
            selectable={false}
            content={footerLeft}
            style={{
              fg: exportError ? theme.mode : theme.muted,
              height: 1,
            }}
          />
        </box>
        <text
          selectable={false}
          content={` ${scrollLabel}`}
          style={{ fg: theme.cyan, height: 1, flexShrink: 0 }}
        />
      </box>
    </box>
  );
}
