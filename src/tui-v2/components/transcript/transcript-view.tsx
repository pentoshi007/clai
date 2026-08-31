/** @jsxImportSource @opentui/react */
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
import { wheelChatDelta } from "../../composer/composer-wheel.js";
import { useTranscriptState } from "../../../ui-core/react/use-transcript-store.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";
import {
  isFileDiffExpanded,
  isItemExpanded,
  transcriptItems,
} from "../../../ui-core/state/transcript-types.js";
import {
  DEFAULT_TRANSCRIPT_MOUNT_ROWS,
  resolveTranscriptMountWindow,
  resolveTranscriptScrollIntent,
  shiftTranscriptWindowStart,
  transcriptWindowStartForItem,
  shouldPinTranscriptBottom,
} from "../../../ui-core/state/transcript-window.js";
import { copyFocusedThinking } from "../../../ui-core/state/thinking-copy.js";
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
const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;
function maxScrollTop(sb: ScrollBoxRenderable): number {
  const vh = sb.viewport?.height ?? 0;
  return Math.max(0, sb.scrollHeight - vh);
}
function isNearBottom(sb: ScrollBoxRenderable, slack = 0): boolean {
  const max = maxScrollTop(sb);
  if (max <= 0) return true;
  return sb.scrollTop >= max - slack;
}
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
  const [windowStart, setWindowStart] = useState<number | undefined>(undefined);
  const mountWindow = useMemo(
    () =>
      resolveTranscriptMountWindow(
        items.length,
        windowStart,
        DEFAULT_TRANSCRIPT_MOUNT_ROWS,
      ),
    [items.length, windowStart],
  );
  const mountedItems = useMemo(
    () => items.slice(mountWindow.start, mountWindow.end),
    [items, mountWindow.start, mountWindow.end],
  );
  const internalScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = (externalScrollRef ?? internalScrollRef) as React.RefObject<ScrollBoxRenderable | null>;
  const closeOverlay = useRef<(() => void) | undefined>(undefined);
  const lastTailId = useRef(items.at(-1)?.id);
  const followBottom = useRef(true);
  const [followSticky, setFollowSticky] = useState(true);
  const wasRunning = useRef(false);
  const dragPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragFrame = useRef<number | undefined>(undefined);
  const pointerGestureActive = useRef(false);
  const copySemanticOnRelease = useRef(false);
  const scrollSnapshot = useRef<
    { scrollTop: number; scrollHeight: number; viewportHeight: number } | undefined
  >(undefined);
  const windowShiftPending = useRef(false);
  const pendingWindowJump = useRef<
    { itemId?: string; edge?: "top" | "bottom" } | undefined
  >(undefined);

  const followKey = useTranscriptFollowKey(state, session.running);

  const [searchOpen, setSearchOpen] = useState(false);
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
    setFollowing(false);
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
    services.transcript.blurThinking();
    pointerGestureActive.current = true;
    copySemanticOnRelease.current = false;
    selection.onMouseDown(event);
    services.focus.focusRegion("transcript");
    setFollowing(false);
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

  function pinToBottom(options?: { forced?: boolean }): void {
    const forced = options?.forced === true;
    const go = (): void => {
      if (!followBottom.current) return;
      if (
        !shouldPinTranscriptBottom({
          following: followBottom.current,
          pointerGestureActive: pointerGestureActive.current,
          forced,
        })
      ) {
        return;
      }
      const sb = scrollRef.current;
      if (!sb) return;
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

  function setFollowing(on: boolean, options?: { forced?: boolean }): void {
    followBottom.current = on;
    setFollowSticky(on);
    if (!on) {
      setWindowStart((current) => current ?? mountWindow.start);
      return;
    }
    const tail = resolveTranscriptMountWindow(
      items.length,
      undefined,
      DEFAULT_TRANSCRIPT_MOUNT_ROWS,
    );
    if (mountWindow.start !== tail.start) {
      pendingWindowJump.current = { edge: "bottom" };
      windowShiftPending.current = true;
    } else {
      pendingWindowJump.current = undefined;
      windowShiftPending.current = false;
    }
    setWindowStart(undefined);
    pinToBottom(options);
  }

  function updateFollowingFromPosition(atLiveBottom: boolean): void {
    setFollowing(atLiveBottom && mountWindow.newerCount === 0);
  }

  function changeWindow(
    nextStart: number,
    jump: { itemId?: string; edge?: "top" | "bottom" },
  ): boolean {
    const resolved = resolveTranscriptMountWindow(
      items.length,
      nextStart,
      DEFAULT_TRANSCRIPT_MOUNT_ROWS,
    );
    if (resolved.start === mountWindow.start) return false;
    pendingWindowJump.current = jump;
    windowShiftPending.current = true;
    setWindowStart(resolved.start);
    followBottom.current = false;
    return true;
  }

  function showOlderWindow(): boolean {
    if (mountWindow.olderCount === 0 || windowShiftPending.current) return false;
    const next = shiftTranscriptWindowStart(
      items.length,
      mountWindow.start,
      "older",
      DEFAULT_TRANSCRIPT_MOUNT_ROWS,
    );
    const itemId = mountedItems[0]?.id;
    return changeWindow(next, itemId ? { itemId } : { edge: "bottom" });
  }

  function showNewerWindow(): boolean {
    if (mountWindow.newerCount === 0 || windowShiftPending.current) return false;
    const next = shiftTranscriptWindowStart(
      items.length,
      mountWindow.start,
      "newer",
      DEFAULT_TRANSCRIPT_MOUNT_ROWS,
    );
    const itemId = mountedItems.at(-1)?.id;
    return changeWindow(next, itemId ? { itemId } : { edge: "top" });
  }

  useLayoutEffect(() => {
    const jump = pendingWindowJump.current;
    if (!jump) return;
    const frame = requestAnimationFrame(() => {
      const sb = scrollRef.current;
      if (sb) {
        if (jump.itemId) sb.scrollChildIntoView(jump.itemId);
        else if (jump.edge === "top") sb.scrollTo(0);
        else if (jump.edge === "bottom") sb.scrollTo(maxScrollTop(sb));
        publishScrollRemainder(sb);
      }
      pendingWindowJump.current = undefined;
      windowShiftPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [mountWindow.start, mountWindow.end]);

  const sessionFingerprint = session.sessionId;
  const lastSessionFp = useRef(sessionFingerprint);
  useEffect(() => {
    if (sessionFingerprint === lastSessionFp.current) return;
    lastSessionFp.current = sessionFingerprint;
    lastTailId.current = items.at(-1)?.id;
    setFollowing(true);
  }, [sessionFingerprint, items.length]);

  useEffect(() => {
    const running = session.running || Boolean(state.runningStatus);
    if (running && !wasRunning.current) {
      setFollowing(true);
    }
    wasRunning.current = running;
  }, [session.running, state.runningStatus]);

  useEffect(() => {
    const tailId = items.at(-1)?.id;
    const tailChanged = tailId !== lastTailId.current;
    lastTailId.current = tailId;
    if (pointerGestureActive.current) return;

    if (tailChanged) {
      const last = items.at(-1);
      if (last?.kind === "user") {
        setFollowing(true);
      }
    }

    if (followBottom.current) {
      pinToBottom();
      return;
    }

    if (tailChanged) {
      const sb = scrollRef.current;
      if (!sb || isNearBottom(sb)) {
        setFollowing(true);
      }
    }
  }, [followKey, items]);

  useEffect(() => {
    if (items.length > 0) return;
    const sb = scrollRef.current;
    if (sb) sb.scrollTo(0);
    followBottom.current = true;
  }, [items.length, introWidth]);

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb) return;
    sb.verticalScrollBar.visible = false;
    sb.horizontalScrollBar.visible = false;
  }, [items.length, introWidth]);

  function scrollMainBy(dy: number): void {
    if (!Number.isFinite(dy) || dy === 0) return;
    if (dy < 0) setFollowing(false);
    clearNativeSelection();
    const sb = scrollRef.current;
    if (!sb) return;
    const intent = resolveTranscriptScrollIntent(
      sb.scrollTop,
      maxScrollTop(sb),
      dy,
    );
    if (intent.reachedOlderEdge && showOlderWindow()) return;
    if (intent.reachedNewerEdge && showNewerWindow()) return;
    sb.scrollTo(intent.nextScrollTop);
    if (!intent.leaveTail) updateFollowingFromPosition(intent.atBottom);
    publishScrollRemainder(sb);
  }

  useEffect(() => {
    return registerTranscriptScrollPort(scrollMainBy);
  }, [items.length, mountWindow.start, mountWindow.end]);

  useEffect(() => {
    return registerTranscriptJumpHandlers(
      () => {
        clearNativeSelection();
        if (mountWindow.start > 0) {
          changeWindow(0, { edge: "top" });
          return;
        }
        const sb = scrollRef.current;
        if (!sb) return;
        setFollowing(false);
        sb.scrollTo(0);
        publishScrollRemainder(sb);
      },
      () => {
        jumpToBottom();
        queueMicrotask(() => publishScrollRemainder(scrollRef.current));
      },
    );
  }, [items.length, mountWindow.start, mountWindow.end]);

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
    pointerGestureActive.current = false;
    setFollowing(true, { forced: true });
  }

  function openSearch(): void {
    if (searchOpen) return;
    if (services.focus.hasOverlay() && services.focus.activeContext() !== "transcript-search") {
      return;
    }
    if (!closeOverlay.current) {
      try {
        closeOverlay.current = services.focus.pushOverlay("transcript-search");
      } catch {
        return;
      }
    }
    setSearchOpen(true);
    setFollowing(false);
  }

  function clearSearch(): void {
    setSearchOpen(false);
    setQuery("");
    setMatchIndex(-1);
    closeOverlay.current?.();
    closeOverlay.current = undefined;
  }

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
    setFollowing(false);
    const itemIndex = items.findIndex((item) => item.id === match.itemId);
    if (
      itemIndex >= 0 &&
      (itemIndex < mountWindow.start || itemIndex >= mountWindow.end)
    ) {
      const start = transcriptWindowStartForItem(
        items.length,
        itemIndex,
        DEFAULT_TRANSCRIPT_MOUNT_ROWS,
      );
      if (changeWindow(start, { itemId: match.itemId })) return;
    }
    queueMicrotask(() => {
      scrollRef.current?.scrollChildIntoView(match.itemId);
      publishScrollRemainder(scrollRef.current);
    });
  }

  function submitSearch(): void {
    const needle = query.trim();
    if (!needle) {
      clearSearch();
      return;
    }
    if (matches.length === 0) {
      notify(services, "No matches", { key: "find", level: "warn", durationMs: 1400 });
      return;
    }
    const index = nextMatchIndex(matches, matchIndex);
    jumpToMatch(index);
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

  function onWheelScroll(event: MouseEvent): void {
    if (!event.scroll) return;
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    scrollMainBy(wheelChatDelta(event.scroll.direction, event.scroll.delta));
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (services.focus.inputCaptured) return;
    const chord = chordFromKeyEvent(key);

    if (searchOpen) {
      if (chord === "escape") {
        key.preventDefault();
        clearSearch();
      }
      return;
    }

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

    if (
      services.focus.activeContext() === "transcript" &&
      services.router.resolve(chord, "transcript") === "transcript.copy-thinking" &&
      state.focusedThinkingId !== undefined
    ) {
      key.preventDefault();
      void copyFocusedThinking(state, services.ports.clipboard).then((result) => {
        if (result === "copied") {
          services.transcript.blurThinking();
          services.toast.success("Reasoning copied", {
            key: "clipboard",
            durationMs: 1600,
          });
          return;
        }
        if (result === "empty") {
          services.toast.info("Nothing to copy", {
            key: "clipboard",
            durationMs: 1400,
          });
          return;
        }
        if (result === "failed") {
          services.toast.error("Copy failed", {
            key: "clipboard",
            durationMs: 2200,
          });
        }
      });
      return;
    }

    if (selection.handleKey(key, chord)) return;
    if (chord === "escape" && renderer.hasSelection) {
      key.preventDefault();
      try {
        renderer.clearSelection();
      } catch {
      }
      return;
    }

    if (services.focus.activeContext() === "transcript") {
      const sb = scrollRef.current;
      if (!sb) return;
      const page = sb.viewport.height || 10;
      if (chord === "up" || chord === "k") {
        key.preventDefault();
        scrollMainBy(-1);
      } else if (chord === "down" || chord === "j") {
        key.preventDefault();
        scrollMainBy(1);
      } else if (chord === "pageup") {
        key.preventDefault();
        scrollMainBy(-page);
      } else if (chord === "pagedown") {
        key.preventDefault();
        scrollMainBy(page);
      } else if (chord === "end" || chord === "ctrl+d") {
        key.preventDefault();
        jumpToBottom();
        publishScrollRemainder(sb);
      } else if (chord === "home" || chord === "ctrl+u") {
        key.preventDefault();
        clearNativeSelection();
        if (mountWindow.start > 0) {
          changeWindow(0, { edge: "top" });
          return;
        }
        setFollowing(false);
        sb.scrollTo(0);
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
        focused={focused}
        stickyScroll={followSticky}
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
        {}
        <IntroCard services={services} theme={theme} width={introWidth} />
        {mountWindow.olderCount > 0 ? (
          <box
            id="transcript-window-older"
            style={{ width: "100%", paddingLeft: 1, paddingBottom: 1 }}
          >
            <text style={{ fg: theme.muted }}>
              {`↑ ${mountWindow.olderCount.toLocaleString()} earlier rows · scroll up or PageUp to load`}
            </text>
          </box>
        ) : null}
        {mountedItems.map((item) => (
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
            thinkingFocused={state.focusedThinkingId === item.id}
          />
        ))}
        {mountWindow.newerCount > 0 ? (
          <box
            id="transcript-window-newer"
            style={{ width: "100%", paddingLeft: 1, paddingTop: 1 }}
          >
            <text style={{ fg: theme.muted }}>
              {`↓ ${mountWindow.newerCount.toLocaleString()} newer rows · scroll down or PageDown to load`}
            </text>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}
