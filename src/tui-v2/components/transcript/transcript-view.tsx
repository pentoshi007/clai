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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import { useTranscriptState } from "../../state/use-transcript-store.js";
import { useSessionState } from "../../state/use-session-state.js";
import { transcriptItems } from "../../state/transcript-types.js";
import { findMatches, nextMatchIndex } from "../../state/transcript-search.js";
import { TranscriptRow } from "./transcript-row.js";
import { SearchBar } from "./search-bar.js";
import { IntroCard } from "./intro-card.js";
import {
  EMPTY_SCROLL_METRICS,
  publishTranscriptScrollMetrics,
  registerTranscriptAutoScroll,
  registerTranscriptScrollPort,
} from "./transcript-scroll-port.js";
import { useNativeSelectionCopy } from "./use-native-selection-copy.js";

export interface TranscriptViewProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly focused: boolean;
  /**
   * Available content columns for the chat pane (not full terminal). Used for
   * the intro card and markdown wrap (tables reflow when the plan pane is open).
   */
  readonly contentWidth?: number | undefined;
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

export function TranscriptView(props: TranscriptViewProps): ReactNode {
  const { services, theme, focused, contentWidth } = props;
  const state = useTranscriptState(services.transcript);
  const session = useSessionState(services.session);
  const items = useMemo(() => transcriptItems(state), [state]);
  const { width: termWidth } = useTerminalDimensions();
  // Prefer the shell-provided chat width so split/overlay plan never draws
  // the intro card (or markdown tables) wider than the remaining columns.
  const paneWidth = Math.max(20, contentWidth ?? termWidth - 6);
  const introWidth = Math.max(40, paneWidth);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const closeOverlay = useRef<(() => void) | undefined>(undefined);
  const lastCount = useRef(items.length);
  /**
   * Product-level follow flag (force re-pin). OpenTUI sticky scroll is the
   * primary follower; this tracks intentional scroll-away.
   */
  const followBottom = useRef(true);
  const wasRunning = useRef(false);

  /**
   * Bumps when anything visible can grow: new rows, streaming tails on the
   * last few items, tool output bytes, running status.
   */
  const followKey = useMemo(() => {
    const parts: string[] = [
      String(state.order.length),
      state.runningStatus ?? "",
      session.running ? "1" : "0",
    ];
    // Last N items — streaming can grow any of the recent rows mid-turn.
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
          parts.push(`c:${item.id}`);
          break;
        default:
          parts.push(id);
      }
    }
    return parts.join("|");
  }, [state, session.running]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const matches = useMemo(() => findMatches(state, query), [state, query]);

  // Drag-select on response/thinking text → OSC 52 copy on release.
  useNativeSelectionCopy(services);

  /**
   * Click/touch in the chat pane: claim keyboard so ↑/↓ scroll the transcript
   * instead of walking prompt history. Child handlers (YOU bubble, tool card)
   * use selectable={false} + preventDefault so clicks open modals without
   * starting a selection.
   */
  function onTranscriptMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (event.defaultPrevented) return;
    services.focus.focusRegion("transcript");
    // Selecting = leave sticky follow so content can scroll with the drag.
    followBottom.current = false;
  }

  function onTranscriptMouseDrag(event: MouseEvent): void {
    if (!event.isDragging) return;
    followBottom.current = false;
    const sb = scrollRef.current;
    if (!sb) return;
    sb.updateAutoScroll(event.x, event.y);
  }

  function onTranscriptMouseUp(): void {
    scrollRef.current?.stopAutoScroll();
  }

  /** Scroll to the true bottom after layout settles (double-rAF). */
  function pinToBottom(): void {
    const sb = scrollRef.current;
    if (!sb) return;
    const go = (): void => {
      sb.scrollTo(maxScrollTop(sb));
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
      const sb = scrollRef.current;
      if (!sb) return;
      const max = maxScrollTop(sb);
      const next = Math.max(0, Math.min(max, sb.scrollTop + dy));
      sb.scrollTo(next);
      followBottom.current = next >= max - 1;
      publishScrollRemainder(sb);
    });
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
    return registerTranscriptAutoScroll({
      update(x, y) {
        const sb = scrollRef.current;
        if (!sb) return;
        followBottom.current = false;
        sb.updateAutoScroll(x, y);
      },
      stop() {
        scrollRef.current?.stopAutoScroll();
      },
    });
  }, []);

  function jumpToBottom(): void {
    setFollowing(true);
  }

  function openSearch(): void {
    if (searchOpen || services.focus.hasOverlay()) return;
    closeOverlay.current = services.focus.pushOverlay("transcript-search");
    setSearchOpen(true);
  }

  function closeSearch(): void {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(-1);
    closeOverlay.current?.();
    closeOverlay.current = undefined;
  }

  function submitSearch(): void {
    const index = nextMatchIndex(matches, matchIndex);
    setMatchIndex(index);
    const match = matches[index];
    if (match) scrollRef.current?.scrollChildIntoView(match.itemId);
  }

  function resendPrompt(prompt: string): void {
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
  }

  function openUserPrompt(prompt: string): void {
    services.overlay.openPromptActions({ prompt, onResend: () => resendPrompt(prompt) });
  }

  /**
   * Wheel over the chat pane: claim focus so ↑/↓ don’t walk prompt history,
   * and stop bubble so App doesn’t also scroll via the port (double-step).
   * Actual motion is handled by ScrollBox’s native onMouseEvent.
   */
  function onWheelScroll(event: MouseEvent): void {
    if (!event.scroll) return;
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
    const chord = chordFromKeyEvent(key);
    if (searchOpen && chord === "escape") {
      key.preventDefault();
      closeSearch();
      return;
    }
    if (chord === "ctrl+r") {
      key.preventDefault();
      openSearch();
    }
    // Arrow / page scroll when transcript owns focus.
    if (!searchOpen && services.focus.activeContext() === "transcript") {
      const sb = scrollRef.current;
      if (!sb) return;
      const page = sb.viewport.height || 10;
      const max = maxScrollTop(sb);
      if (chord === "up" || chord === "k") {
        key.preventDefault();
        sb.scrollTo(Math.max(0, sb.scrollTop - 1));
        followBottom.current = false;
        publishScrollRemainder(sb);
      } else if (chord === "down" || chord === "j") {
        key.preventDefault();
        const next = Math.min(max, sb.scrollTop + 1);
        sb.scrollTo(next);
        followBottom.current = next >= max - 1;
        publishScrollRemainder(sb);
      } else if (chord === "pageup") {
        key.preventDefault();
        sb.scrollTo(Math.max(0, sb.scrollTop - page));
        followBottom.current = false;
        publishScrollRemainder(sb);
      } else if (chord === "pagedown") {
        key.preventDefault();
        const next = Math.min(max, sb.scrollTop + page);
        sb.scrollTo(next);
        followBottom.current = next >= max - 1;
        publishScrollRemainder(sb);
      } else if (chord === "end") {
        key.preventDefault();
        jumpToBottom();
        publishScrollRemainder(sb);
      } else if (chord === "home") {
        key.preventDefault();
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
      onMouseDragEnd={onTranscriptMouseUp}
      onMouseScroll={onWheelScroll}
    >
      {searchOpen ? (
        <SearchBar
          theme={theme}
          query={query}
          matchCount={matches.length}
          activeOrdinal={matchIndex + 1}
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
            state={state}
            theme={theme}
            store={services.transcript}
            spool={services.session.spool}
            services={services}
            onOpenUserPrompt={openUserPrompt}
            contentWidth={paneWidth}
          />
        ))}
      </scrollbox>
    </box>
  );
}
