/** @jsxImportSource @opentui/react */
/**
 * Chat pane: virtualized, auto-following transcript (V2-050, 056, 057).
 *
 * Auto-follow uses OpenTUI ScrollBox `stickyScroll` + `stickyStart="bottom"`
 * so new rows and growing stream text pin the viewport to the latest content.
 * Manual scroll-up suspends follow (library `_hasManualScroll`); scrolling back
 * to the bottom or a new user prompt re-engages. We still call pinToBottom on
 * content changes as a belt-and-suspenders for layout races.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import { useTranscriptState } from "../../../ui-core/react/use-transcript-store.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";
import {
  isFileDiffExpanded,
  isItemExpanded,
  transcriptItems,
} from "../../../ui-core/state/transcript-types.js";
import {
  findMatches,
  nextMatchIndex,
  prevMatchIndex,
} from "../../../ui-core/state/transcript-search.js";
import { TranscriptRow } from "./transcript-row.js";
import { SearchBar } from "./search-bar.js";
import { notify } from "../../../ui-core/notify.js";
import { IntroCard } from "./intro-card.js";
import {
  EMPTY_SCROLL_METRICS,
  publishTranscriptScrollMetrics,
  registerTranscriptAutoScroll,
  registerTranscriptJumpHandlers,
  registerTranscriptScrollPort,
} from "./transcript-scroll-port.js";
import { useNativeSelectionCopy } from "./use-native-selection-copy.js";
import { useTranscriptSelection } from "./use-transcript-selection.js";
export interface TranscriptViewProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly focused: boolean;
  readonly contentWidth?: number | undefined;
  readonly scrollRef?: React.RefObject<ScrollBoxRenderable | null>;
}
/** Hide OpenTUI's native scrollbar chrome. */
const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;
/** Max scrollTop for a ScrollBox (not scrollHeight — that overshoots). */
function maxScrollTop(sb: ScrollBoxRenderable): number {
  const vh = sb.viewport?.height ?? 0;
  return Math.max(0, sb.scrollHeight - vh);
}
function isNearBottom(sb: ScrollBoxRenderable, slack = 2): boolean {
  const max = maxScrollTop(sb);
  if (max <= 0) return true;
  return sb.scrollTop >= max - slack;
}
/** Classic status badges: ▲ lines above · ▼ lines below the viewport. */
function publishScrollRemainder(sb: ScrollBoxRenderable | null): void {
  if (!sb) {
    publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
    return;
  }
  const max = maxScrollTop(sb);
  const top = Math.max(0, Math.min(max, sb.scrollTop));
  publishTranscriptScrollMetrics({
    linesAbove: top,
    linesBelow: Math.max(0, max - top),
  });
}
export function useTranscriptFollowKey(
  state: ReturnType<typeof useTranscriptState>,
  running: boolean,
): string {
  return useMemo(() => {
    const parts: string[] = [
      String(state.order.length),
      state.runningStatus ?? "",
      running ? "1" : "0",
    ];
    const window = state.order.slice(-8);
    for (const id of window) {
      const item = state.byId.get(id);
      if (!item) continue;
      switch (item.kind) {
        case "assistant":
          parts.push(`a:${item.id}:${item.text.length}:${item.streaming ? 1 : 0}`);
          break;
        case "thinking":
          parts.push(`t:${item.id}:${item.content.length}:${item.streaming ? 1 : 0}`);
          break;
        case "user":
          parts.push(`u:${item.id}:${item.text.length}`);
          break;
        case "tool":
          parts.push(`o:${item.id}:${item.outputBytes}:${item.status}`);
          break;
        case "notice":
          parts.push(`n:${item.id}:${item.text.length}`);
          break;
        case "compacted":
          parts.push(
            `c:${item.id}:${item.summary.length}:${item.streaming ? 1 : 0}:${item.error?.length ?? 0}`,
          );
          break;
        default:
          parts.push(id);
      }
    }
    return parts.join("|");
  }, [state, running]);
}

export function TranscriptView(props: TranscriptViewProps): ReactNode {
  const { services, theme, focused, contentWidth, scrollRef: externalScrollRef } = props;
  const state = useTranscriptState(services.transcript);
  const session = useSessionState(services.session);
  const items = useMemo(() => transcriptItems(state), [state]);
  const { width: termWidth } = useTerminalDimensions();
  const paneWidth = Math.max(20, contentWidth ?? termWidth - 6);
  const introWidth = Math.max(40, paneWidth);
  const internalScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = (externalScrollRef ?? internalScrollRef) as React.RefObject<ScrollBoxRenderable | null>;
  const closeOverlay = useRef<(() => void) | undefined>(undefined);
  const lastCount = useRef(items.length);
  /**
   * Product-level follow flag (force re-pin). OpenTUI sticky scroll is the
   * primary follower; this tracks intentional scroll-away.
   */
  const followBottom = useRef(true);
  const wasRunning = useRef(false);
  const dragPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragFrame = useRef<number | undefined>(undefined);
  const pointerGestureActive = useRef(false);
  const copySemanticOnRelease = useRef(false);
  const scrollSnapshot = useRef<
    { scrollTop: number; scrollHeight: number; viewportHeight: number } | undefined
  >(undefined);

  const followKey = useTranscriptFollowKey(state, session.running);

  const [searchOpen, setSearchOpen] = useState(false);
  /** Sticky query kept after Enter so n/N + highlights work (pager model). */
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const matches = useMemo(() => findMatches(state, query), [state, query]);
  const matchedItemIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of matches) set.add(m.itemId);
    return set;
  }, [matches]);
  const activeMatchItemId =
    matchIndex >= 0 && matchIndex < matches.length
      ? matches[matchIndex]!.itemId
      : undefined;
  const searchActive = query.trim().length > 0;

  useNativeSelectionCopy(services);
  const renderer = useRenderer();

  const selection = useTranscriptSelection({
    services,
    state,
    spool: services.session.spool,
    scrollRef,
    focused,
  });

  function clearNativeSelection(): boolean {
    if (!renderer.hasSelection) return false;
    try {
      renderer.clearSelection();
      return true;
    } catch {
      return false;
    }
  }

  function isAutoScrollEdge(sb: ScrollBoxRenderable, pointerY: number): boolean {
    const relativeY = pointerY - sb.y;
    return relativeY <= 3 || sb.height - relativeY <= 3;
  }

  function canAutoScroll(sb: ScrollBoxRenderable, pointerY: number): boolean {
    const relativeY = pointerY - sb.y;
    if (relativeY <= 3) return sb.scrollTop > 0;
    if (sb.height - relativeY <= 3) return sb.scrollTop < maxScrollTop(sb);
    return false;
  }

  function stopDragRefresh(): void {
    dragPointer.current = undefined;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
  }

  function refreshSemanticDrag(): void {
    dragFrame.current = undefined;
    const pointer = dragPointer.current;
    const sb = scrollRef.current;
    if (!pointer || !sb) {
      stopDragRefresh();
      return;
    }
    selection.onMouseDrag(pointer);
    if (!isAutoScrollEdge(sb, pointer.y)) {
      stopDragRefresh();
      return;
    }
    dragFrame.current = requestAnimationFrame(refreshSemanticDrag);
  }

  function updateTranscriptDrag(x: number, y: number): void {
    const pointer = { x, y };
    selection.onMouseDrag(pointer);
    followBottom.current = false;
    const sb = scrollRef.current;
    if (!sb) return;
    if (isAutoScrollEdge(sb, y)) {
      dragPointer.current = pointer;
      if (dragFrame.current === undefined) {
        dragFrame.current = requestAnimationFrame(refreshSemanticDrag);
      }
    } else {
      stopDragRefresh();
    }
    sb.updateAutoScroll(x, y);
  }

  function copyHandedOffSelection(): void {
    if (!copySemanticOnRelease.current) return;
    copySemanticOnRelease.current = false;
    if (!services.selection.hasSelection()) return;
    void services.selection.copy().then((result) => {
      if (result.status === "copied") {
        services.toast.success("Copied to clipboard", {
          key: "clipboard",
          durationMs: 1600,
        });
      } else if (result.status === "failed") {
        services.toast.error("Copy failed", {
          key: "clipboard",
          durationMs: 2200,
        });
      }
    });
  }
  useLayoutEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    const current = {
      scrollTop: sb.scrollTop,
      scrollHeight: sb.scrollHeight,
      viewportHeight: sb.viewport.height,
    };
    const previous = scrollSnapshot.current;
    if (previous && renderer.hasSelection && !pointerGestureActive.current) {
      const previousMax = Math.max(0, previous.scrollHeight - previous.viewportHeight);
      const wasAtBottom = previousMax === 0 || previous.scrollTop >= previousMax - 2;
      const moved = current.scrollTop !== previous.scrollTop;
      const grewAtBottom = current.scrollHeight !== previous.scrollHeight && wasAtBottom;
      if (moved || grewAtBottom) {
        clearNativeSelection();
      }
    }
    scrollSnapshot.current = current;
  });

  function onTranscriptMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (event.defaultPrevented) return;
    stopDragRefresh();
    pointerGestureActive.current = true;
    copySemanticOnRelease.current = false;
    selection.onMouseDown(event);
    services.focus.focusRegion("transcript");
    followBottom.current = false;
  }

  function onTranscriptMouseDrag(event: MouseEvent): void {
    updateTranscriptDrag(event.x, event.y);
  }

  function onTranscriptMouseUp(event: MouseEvent): void {
    stopDragRefresh();
    pointerGestureActive.current = false;
    selection.onMouseUp(event);
    copyHandedOffSelection();
    scrollRef.current?.stopAutoScroll();
  }

  function onTranscriptMouseDragEnd(): void {
    stopDragRefresh();
    pointerGestureActive.current = false;
    selection.onMouseDragEnd();
    copyHandedOffSelection();
    scrollRef.current?.stopAutoScroll();
  }

  /** Scroll to the true bottom after layout settles (double-rAF). */
  function pinToBottom(): void {
    if (pointerGestureActive.current) return;
    const sb = scrollRef.current;
    if (!sb) return;
    const go = (): void => {
      const next = maxScrollTop(sb);
      if (sb.scrollTop === next) return;
      clearNativeSelection();
      sb.scrollTo(next);
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
  }

  function setFollowing(on: boolean): void {
    followBottom.current = on;
    if (on) pinToBottom();
  }

  // /history hydrate (or /new) swaps the first item id — re-pin to bottom.
  const sessionFingerprint = state.order[0] ?? "__empty__";
  const lastSessionFp = useRef(sessionFingerprint);
  useEffect(() => {
    if (sessionFingerprint === lastSessionFp.current) return;
    lastSessionFp.current = sessionFingerprint;
    lastCount.current = items.length;
    setFollowing(true);
  }, [sessionFingerprint, items.length]);

  // New agent turn: always re-engage follow so the live stream is visible.
  useEffect(() => {
    const running = session.running || Boolean(state.runningStatus);
    if (running && !wasRunning.current) {
      setFollowing(true);
    }
    wasRunning.current = running;
  }, [session.running, state.runningStatus]);

  useEffect(() => {
    const grew = items.length - lastCount.current;
    lastCount.current = items.length;
    if (pointerGestureActive.current) return;

    // New user prompt always re-engages follow (classic: show what you just sent).
    if (grew > 0) {
      const last = items[items.length - 1];
      if (last?.kind === "user") {
        followBottom.current = true;
      }
    }

    // While a turn is live, keep following unless the user has scrolled away.
    // (followBottom is cleared by wheel/keys; stickyScroll also respects that.)
    if (followBottom.current) {
      pinToBottom();
      return;
    }

    if (grew > 0) {
      const sb = scrollRef.current;
      if (!sb || isNearBottom(sb)) {
        // Near bottom → re-engage follow.
        setFollowing(true);
      }
    }
  }, [followKey, items]);

  // Keep the intro card at the top when the transcript is empty.
  useEffect(() => {
    if (items.length > 0) return;
    const sb = scrollRef.current;
    if (sb) sb.scrollTo(0);
    followBottom.current = true;
  }, [items.length, introWidth]);

  // Force-hide scrollbars after mount (constructor options alone can be
  // overridden by OpenTUI's auto-visibility when content overflows).
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    sb.verticalScrollBar.visible = false;
    sb.horizontalScrollBar.visible = false;
  }, [items.length, introWidth]);

  // App + composer forward every free wheel event here so trackpad never
  // lands on the focused textarea and walks prompt history instead.
  useEffect(() => {
    return registerTranscriptScrollPort((dy) => {
      clearNativeSelection();
      const sb = scrollRef.current;
      if (!sb) return;
      const max = maxScrollTop(sb);
      const next = Math.max(0, Math.min(max, sb.scrollTop + dy));
      sb.scrollTo(next);
      followBottom.current = next >= max - 1;
      publishScrollRemainder(sb);
    });
  }, []);

  // g / G absolute jumps (also reachable from App when transcript is focused).
  useEffect(() => {
    return registerTranscriptJumpHandlers(
      () => {
        clearNativeSelection();
        const sb = scrollRef.current;
        if (!sb) return;
        sb.scrollTo(0);
        followBottom.current = false;
        publishScrollRemainder(sb);
      },
      () => {
        followBottom.current = true;
        pinToBottom();
        queueMicrotask(() => publishScrollRemainder(scrollRef.current));
      },
    );
  }, []);

  // Publish ▲/▼ remaining-line metrics for the status strip under the input.
  // Poll lightly: OpenTUI ScrollBox has no scroll-event subscription.
  useEffect(() => {
    const tick = (): void => {
      publishScrollRemainder(scrollRef.current);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => {
      clearInterval(id);
      publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
    };
  }, [followKey, items.length, introWidth]);

  // Selection drag often ends over the composer; App forwards pointer coords
  // here so edge-autoscroll continues when selecting downward past the pane.
  useEffect(() => {
    const unregister = registerTranscriptAutoScroll({
      update(x, y) {
        updateTranscriptDrag(x, y);
      },
      stop() {
        stopDragRefresh();
        pointerGestureActive.current = false;
        selection.onMouseDragEnd();
        copyHandedOffSelection();
        scrollRef.current?.stopAutoScroll();
      },
    });
    return () => {
      stopDragRefresh();
      unregister();
    };
  }, []);

  function jumpToBottom(): void {
    setFollowing(true);
  }

  function openSearch(): void {
    // Allow re-opening the filter to edit the sticky query.
    if (searchOpen) return;
    // Another overlay (pager/picker) owns focus — do not stack.
    if (services.focus.hasOverlay() && services.focus.activeContext() !== "transcript-search") {
      return;
    }
    if (!closeOverlay.current) {
      try {
        closeOverlay.current = services.focus.pushOverlay("transcript-search");
      } catch {
        // Overlay already open — still show the bar if we own search.
        return;
      }
    }
    setSearchOpen(true);
    followBottom.current = false;
  }

  /** Drop filter input + sticky query + highlights. */
  function clearSearch(): void {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(-1);
    closeOverlay.current?.();
    closeOverlay.current = undefined;
  }

  /** Close only the filter input; keep sticky query for n/N + highlights. */
  function leaveFilterKeepQuery(): void {
    setSearchOpen(false);
    closeOverlay.current?.();
    closeOverlay.current = undefined;
    services.focus.focusRegion("transcript");
  }

  function jumpToMatch(index: number): void {
    if (index < 0 || matches.length === 0) {
      setMatchIndex(-1);
      return;
    }
    setMatchIndex(index);
    const match = matches[index];
    if (!match) return;
    clearNativeSelection();
    followBottom.current = false;
    // Defer until after paint so the row id exists in the scroll tree.
    queueMicrotask(() => {
      scrollRef.current?.scrollChildIntoView(match.itemId);
      publishScrollRemainder(scrollRef.current);
    });
  }

  function submitSearch(): void {
    const needle = query.trim();
    if (!needle) {
      // Empty submit just closes the filter.
      clearSearch();
      return;
    }
    if (matches.length === 0) {
      notify(services, "No matches", { key: "find", level: "warn", durationMs: 1400 });
      // Keep filter open so the user can edit the term.
      return;
    }
    const index = nextMatchIndex(matches, matchIndex);
    jumpToMatch(index);
    // Pager model: leave sticky find strip + n/N, hide the input.
    leaveFilterKeepQuery();
    notify(services, `Find · ${index + 1}/${matches.length}`, {
      key: "find",
      durationMs: 1200,
    });
  }

  function nextSearchMatch(): void {
    if (!searchActive || matches.length === 0) return;
    jumpToMatch(nextMatchIndex(matches, matchIndex));
  }

  function prevSearchMatch(): void {
    if (!searchActive || matches.length === 0) return;
    jumpToMatch(prevMatchIndex(matches, matchIndex));
  }

  const resendPrompt = useCallback(
    (prompt: string): void => {
      void (async () => {
        const trimmed = prompt.trim();
        if (services.commands.looksLikeCommand(trimmed)) {
          const invocation = services.commands.parse(trimmed);
          if (!invocation) {
            services.session.notice(
              "warn",
              `unknown command: ${trimmed.split(/\s/, 1)[0] ?? trimmed}. Try /help`,
            );
            return;
          }
          if (!(await services.commands.dispatch(invocation))) {
            services.session.notice(
              "warn",
              `command /${invocation.name} is not available right now`,
            );
          }
          return;
        }
        if (services.session.getState().running) services.session.enqueue(prompt);
        else await services.session.submit(prompt);
      })();
    },
    [services],
  );

  const openUserPrompt = useCallback(
    (prompt: string): void => {
      services.overlay.openPromptActions({ prompt, onResend: () => resendPrompt(prompt) });
    },
    [services, resendPrompt],
  );

  /**
   * Wheel over the chat pane: claim focus so ↑/↓ don’t walk prompt history,
   * and stop bubble so App doesn’t also scroll via the port (double-step).
   * Actual motion is handled by ScrollBox’s native onMouseEvent.
   */
  function onWheelScroll(event: MouseEvent): void {
    if (!event.scroll) return;
    clearNativeSelection();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    // Keep followBottom in sync after the native ScrollBox applies the delta.
    queueMicrotask(() => {
      const sb = scrollRef.current;
      if (!sb) return;
      followBottom.current = isNearBottom(sb);
      publishScrollRemainder(sb);
    });
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (services.focus.inputCaptured) return;
    const chord = chordFromKeyEvent(key);

    // ── Filter input open: Esc closes everything; other keys go to <input>.
    if (searchOpen) {
      if (chord === "escape") {
        key.preventDefault();
        clearSearch();
      }
      // Enter is handled by SearchBar onSubmit → submitSearch.
      return;
    }

    // ── Sticky find (query kept, bar closed): n/N + Esc + ^R to re-edit.
    if (searchActive) {
      if (chord === "escape") {
        key.preventDefault();
        clearSearch();
        return;
      }
      if (chord === "n") {
        key.preventDefault();
        nextSearchMatch();
        return;
      }
      if (chord === "shift+n") {
        key.preventDefault();
        prevSearchMatch();
        return;
      }
      if (chord === "ctrl+r") {
        key.preventDefault();
        openSearch();
        return;
      }
    }

    if (chord === "ctrl+r") {
      key.preventDefault();
      openSearch();
      return;
    }

    // Selection chords first: Esc only lands here when there is a selection to
    // clear, so the global cancel ladder still sees every other Esc.
    if (selection.handleKey(key, chord)) return;
    if (chord === "escape" && renderer.hasSelection) {
      key.preventDefault();
      try {
        renderer.clearSelection();
      } catch {
        /* renderer already torn down */
      }
      return;
    }

    // Arrow / page scroll when transcript owns focus.
    if (services.focus.activeContext() === "transcript") {
      const sb = scrollRef.current;
      if (!sb) return;
      const page = sb.viewport.height || 10;
      const max = maxScrollTop(sb);
      if (chord === "up" || chord === "k") {
        key.preventDefault();
        clearNativeSelection();
        sb.scrollTo(Math.max(0, sb.scrollTop - 1));
        followBottom.current = false;
        publishScrollRemainder(sb);
      } else if (chord === "down" || chord === "j") {
        key.preventDefault();
        clearNativeSelection();
        const next = Math.min(max, sb.scrollTop + 1);
        sb.scrollTo(next);
        followBottom.current = next >= max - 1;
        publishScrollRemainder(sb);
      } else if (chord === "pageup") {
        key.preventDefault();
        clearNativeSelection();
        sb.scrollTo(Math.max(0, sb.scrollTop - page));
        followBottom.current = false;
        publishScrollRemainder(sb);
      } else if (chord === "pagedown") {
        key.preventDefault();
        clearNativeSelection();
        const next = Math.min(max, sb.scrollTop + page);
        sb.scrollTo(next);
        followBottom.current = next >= max - 1;
        publishScrollRemainder(sb);
      } else if (chord === "end" || chord === "ctrl+d") {
        // ^D / End — absolute bottom of the chat.
        key.preventDefault();
        jumpToBottom();
        publishScrollRemainder(sb);
      } else if (chord === "home" || chord === "ctrl+u") {
        // ^U / Home — absolute top of the chat (intro card).
        key.preventDefault();
        clearNativeSelection();
        sb.scrollTo(0);
        followBottom.current = false;
        publishScrollRemainder(sb);
      }
    }
  });

  return (
    <box
      style={{ flexDirection: "column", flexGrow: 1, width: "100%", position: "relative" }}
      onMouseDown={onTranscriptMouseDown}
      onMouseDrag={onTranscriptMouseDrag}
      onMouseUp={onTranscriptMouseUp}
      onMouseDragEnd={onTranscriptMouseDragEnd}
      onMouseScroll={onWheelScroll}
    >
      {searchOpen || searchActive ? (
        <SearchBar
          theme={theme}
          query={query}
          matchCount={matches.length}
          activeOrdinal={matchIndex >= 0 ? matchIndex + 1 : 0}
          editing={searchOpen}
          onQueryChange={(value) => {
            setQuery(value);
            setMatchIndex(-1);
          }}
          onSubmit={submitSearch}
        />
      ) : null}
      <scrollbox
        ref={scrollRef}
        // Keep the scrollbox focusable for wheel even when the composer has
        // keyboard focus; selection/mouse-down still routes region focus.
        focused={focused}
        // Native auto-follow: when content grows and the user is (or returns)
        // at the bottom, stay pinned to the latest agent output.
        stickyScroll
        stickyStart={items.length > 0 ? "bottom" : "top"}
        viewportCulling
        scrollY
        scrollX={false}
        scrollbarOptions={HIDDEN_SCROLLBARS}
        verticalScrollbarOptions={HIDDEN_SCROLLBARS}
        horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
        style={{ flexGrow: 1, width: "100%" }}
        onMouseScroll={onWheelScroll}
      >
        {/* Persistent intro/model card — first scroll child, same as legacy TUI. */}
        <IntroCard services={services} theme={theme} width={introWidth} />
        {items.map((item) => (
          <TranscriptRow
            key={item.id}
            item={item}
            expanded={isItemExpanded(state, item)}
            fileDiffExpanded={
              item.kind === "tool" ? isFileDiffExpanded(state, item.id) : false
            }
            expandThinkingGlobal={state.expandThinkingGlobal}
            expandOutputGlobal={state.expandOutputGlobal}
            expandFileDiffsGlobal={state.expandFileDiffsGlobal}
            theme={theme}
            store={services.transcript}
            spool={services.session.spool}
            services={services}
            onOpenUserPrompt={openUserPrompt}
            contentWidth={paneWidth}
            searchMatched={searchActive && matchedItemIds.has(item.id)}
            searchActiveMatch={item.id === activeMatchItemId}
          />
        ))}
      </scrollbox>
    </box>
  );
}
