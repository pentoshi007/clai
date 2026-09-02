/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { TerminalDimensionsContext } from "../hooks/terminal-dimensions.js";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import {
  COMPOSER_MAX_HEIGHT,
  MIN_CHAT_ROWS,
  computeLayout,
} from "../../ui-core/layout/compute-layout.js";
import { ComposerEditor } from "../composer/composer-editor.js";
import { maxComposerTextRows } from "../../ui-core/composer/composer-height.js";
import { TranscriptView, useTranscriptFollowKey } from "../components/transcript/transcript-view.js";
import { TranscriptScrollbar } from "../components/transcript/transcript-scrollbar.js";
import { PlanView } from "../components/plan/plan-view.js";
import { OverlayHost } from "../components/overlay/overlay-host.js";
import { QueuePanel } from "../components/queue/queue-panel.js";
import { ResponderPanel } from "../components/jobs/jobs-panel.js";
import {
  chordFromKeyEvent,
  consumeCancellationKeyRepeat,
  isKeyEventRelease,
} from "../input/chord-from-opentui-key.js";
import {
  escapeCancellationAction,
  preserveEscapeArmAfterTurn,
} from "../input/escape-cancellation.js";
import { usePlan } from "../../ui-core/react/use-plan.js";
import { useOverlayState } from "../../ui-core/react/use-overlay.js";
import { useTranscriptState } from "../../ui-core/react/use-transcript-store.js";
import { useSessionState } from "../../ui-core/react/use-session-state.js";
import { useServices, useTheme } from "../../ui-core/react/providers.js";
import { promptPlanApprovalIfNeeded } from "../../ui-core/plan/plan-lifecycle.js";
import { StatusLine } from "../components/status/status-line.js";
import { ToastHost } from "../components/toast/toast-host.js";
import {
  paneSlideTop,
  paneSlideWidth,
} from "../components/plan/plan-pane-anim.js";
import { usePanePresence } from "../components/plan/use-pane-presence.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { useHasDraft } from "../../ui-core/react/use-has-draft.js";
import { formatShortcutsReference } from "../../ui-core/actions/format-shortcuts.js";
import { formatCommandHelpMarkdown } from "../../ui-core/rendering/format-help.js";
import { armedCancelHint } from "../../ui-core/rendering/status-segments.js";
import {
  CTRL_C_QUIT_WINDOW_MS,
  ESC_CANCEL_WINDOW_MS,
  ESC_SAME_PRESS_MS,
} from "../../ui-core/actions/cancel-timing.js";
import { notify, notifyWarn } from "../../ui-core/notify.js";
import { setDefaultMode } from "../../store/config.js";
import { maybeShowUpdateToast } from "../../ui-core/commands/startup-update.js";
import { modeSwitchSummary, nextMode } from "../../ui-core/actions/mode-cycle.js";
import {
  appWidthBudget,
  focusAfterPlanSuppression,
} from "./layout-widths.js";


export function App(): ReactNode {
  const { width, height } = useTerminalDimensions();
  const services = useServices();
  const theme = useTheme();
  const [focusContext, setFocusContext] = useState(services.focus.activeContext());
  const [planVisible, setPlanVisible] = useState(false);
  const plan = usePlan(services.plan);
  const overlay = useOverlayState(services.overlay);
  const transcript = useTranscriptState(services.transcript);
  const lastCtrlC = useRef(0);
  const lastEscape = useRef(0);
  const lastEscapeHandledAt = useRef(0);
  const escapeCancelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const escapeCancelArmedRef = useRef(false);
  const [escapeCancelArmed, setEscapeCancelArmed] = useState(false);
  const hasDraft = useHasDraft();
  const seenPlanKey = useRef<string | undefined>(undefined);
  const [composerSeed, setComposerSeed] = useState<
    { token: number; text: string } | undefined
  >(undefined);
  const [contextLimitEditing, setContextLimitEditing] = useState(false);

  const panePresence = usePanePresence(planVisible);
  const planPresent = panePresence.mounted;

  useEffect(() => services.focus.onChange(setFocusContext), [services.focus]);

  useEffect(() => {
    return services.session.onTurnEnd((result) => {
      if (
        !preserveEscapeArmAfterTurn(
          services.cancel.hasCancelableWork(),
        )
      ) {
        clearEscapeCancellation();
      }
      if (result.status === "completed") void promptPlanApprovalIfNeeded(services);
    });
  }, [services]);

  useEffect(() => {
    const disarmWhenIdle = (): void => {
      if (!escapeCancelArmedRef.current) return;
      if (!services.cancel.hasCancelableWork()) clearEscapeCancellation();
    };
    const unsubJobs = services.ports.jobs.subscribe(disarmWhenIdle);
    const unsubInterruptible = services.interruptible.subscribe(disarmWhenIdle);
    return () => {
      unsubJobs();
      unsubInterruptible();
    };
  }, [services]);

  useEffect(() => {
    return () => {
      if (escapeCancelTimer.current) clearTimeout(escapeCancelTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void maybeShowUpdateToast(services, () => cancelled).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    if (!plan) {
      seenPlanKey.current = undefined;
      setPlanVisible(false);
      return;
    }
    const key = `${plan.sessionId}:${plan.updatedAt}`;
    if (seenPlanKey.current === key) return;
    seenPlanKey.current = key;
    setPlanVisible(true);
  }, [plan]);

  const terminalWidth = Number.isFinite(width)
    ? Math.max(0, Math.floor(width))
    : 0;
  const layout = computeLayout({
    columns: terminalWidth,
    rows: height,
    planVisible: planPresent,
    splitEnabled: layoutSupportsSplit(terminalWidth),
  });

  const composerMaxTextRows = maxComposerTextRows({
    terminalRows: height,
    statusHeight: layout.status.height,
    minChatRows: MIN_CHAT_ROWS,
    maxCap: COMPOSER_MAX_HEIGHT,
  });

  const session = useSessionState(services.session);
  const transcriptScrollRef = useRef<ScrollBoxRenderable>(null);
  const followKey = useTranscriptFollowKey(transcript, session.running);
  const completionRows = Math.max(6, Math.min(12, Math.floor(height / 3)));
  const requestedSplitPlanWidth =
    planPresent && layout.plan.placement === "split"
      ? paneSlideWidth(panePresence.progress, layout.plan.width)
      : 0;
  const widthBudget = appWidthBudget({
    terminalWidth,
    planPresent,
    planPlacement: layout.plan.placement,
    requestedSplitPlanWidth,
  });
  const horizontalPadding = widthBudget.horizontalPadding;
  const contentInnerWidth = widthBudget.contentInnerWidth;
  const planChatGap = widthBudget.planChatGap;
  const splitPlanW = widthBudget.splitPlanWidth;
  const overlayPlanW = widthBudget.overlayReserveWidth;
  const chatContentWidth = widthBudget.chatContentWidth;
  const planRendered =
    (layout.plan.placement === "split" && splitPlanW > 0) ||
    (layout.plan.placement === "overlay" && widthBudget.showPlanOverlay);

  useEffect(() => {
    const fallback = focusAfterPlanSuppression(focusContext, planRendered);
    if (fallback) services.focus.focusRegion(fallback);
  }, [focusContext, planRendered, services.focus]);

  useKeyboard((key) => {
    if (isKeyEventRelease(key)) return;

    const chord = chordFromKeyEvent(key);
    if (consumeCancellationKeyRepeat(key, chord)) return;

    if (overlay.kind === "secret" || overlay.kind === "confirm" || overlay.kind === "scope-editor") {
      if (chord === "escape" || chord === "ctrl+c") {
        key.preventDefault();
        const dismissed = services.overlay.cancelBlockingPrompt();
        if (chord === "ctrl+c") {
          const now = Date.now();
          const doublePress =
            lastCtrlC.current > 0 &&
            now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS;
          services.cancel.abortForeground();
          if (doublePress) {
            services.requestExit();
            return;
          }
          lastCtrlC.current = now;
          notifyWarn(
            services,
            dismissed
              ? "Prompt cancelled · Ctrl+C again to exit"
              : "Turn aborted · Ctrl+C again to exit",
            { key: "interrupt", durationMs: 2200 },
          );
          return;
        }
        handleEscapeCancellation(dismissed);
        return;
      }
      return;
    }

    if (overlay.kind !== "none") {
      if (chord === "escape") {
        key.preventDefault();
        services.overlay.close();
        handleEscapeCancellation(true);
        return;
      }
      if (chord === "ctrl+c") {
        key.preventDefault();
        const now = Date.now();
        const doublePress =
          lastCtrlC.current > 0 && now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS;
        services.cancel.abortForeground();
        if (doublePress) {
          services.requestExit();
          return;
        }
        lastCtrlC.current = now;
        notifyWarn(services, "Ctrl+C again to exit", {
          key: "interrupt",
          durationMs: 2200,
        });
      }
      return;
    }

    if (contextLimitEditing && chord !== "ctrl+c") return;

    if (chord === "escape" && focusContext === "transcript" && !services.selection.hasSelection()) {
      key.preventDefault();
      handleEscapeCancellation(false);
      return;
    }

    if (focusContext === "composer" && chord === "tab") return;
    const action = services.router.resolve(chord, focusContext);
    if (!action) return;
    switch (action) {
      case "app.cancel":
        key.preventDefault();
        handleEscapeCancellation(services.overlay.cancelBlockingPrompt());
        break;
      case "app.interrupt": {
        key.preventDefault();
        services.overlay.cancelBlockingPrompt();
        const now = Date.now();
        const doublePress =
          lastCtrlC.current > 0 &&
          now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS;
        const outcome = services.cancel.abortForeground();
        if (outcome.turnAborted) {
          if (doublePress) {
            services.requestExit();
            break;
          }
          lastCtrlC.current = now;
          notifyWarn(services, "Turn aborted · Ctrl+C again to exit", {
            key: "interrupt",
            durationMs: 2200,
          });
          break;
        }
        if (outcome.interruptibleCancelled > 0) {
          if (doublePress) {
            services.requestExit();
            break;
          }
          lastCtrlC.current = now;
          notifyWarn(services, "Operation cancelled · Ctrl+C again to exit", {
            key: "interrupt",
            durationMs: 2200,
          });
          break;
        }
        if (doublePress) {
          services.requestExit();
        } else {
          lastCtrlC.current = now;
          notify(services, "Ctrl+C again to exit", {
            key: "interrupt",
            durationMs: 2200,
          });
        }
        break;
      }
      case "app.quit":
        key.preventDefault();
        services.requestExit();
        break;
      case "app.toggle-plan":
        key.preventDefault();
        toggleTasksPane();
        break;
      case "app.jobs":
        key.preventDefault();
        services.overlay.openJobs();
        notify(services, "Jobs panel", { key: "jobs", durationMs: 1200 });
        break;
      case "app.cycle-mode": {
        key.preventDefault();
        cycleMode();
        break;
      }
      case "app.help":
        key.preventDefault();
        services.overlay.openPager(
          "Commands",
          formatCommandHelpMarkdown(services.commands.help()),
          undefined,
          undefined,
          "force",
        );
        notify(services, "Commands · /help", { key: "help", durationMs: 1200 });
        break;
      case "plan.toggle-detail":
        key.preventDefault();
        void (async () => {
          let live = services.plan.current() ?? plan;
          if (!live) {
            live = await services.plan
              .load(services.session.sessionId)
              .catch(() => undefined);
          }
          if (live) {
            const { formatPlanPagerDocument } = await import(
              "../../ui-core/rendering/plan-view.js"
            );
            services.overlay.openPager(
              `Plan · ${live.goal}`,
              formatPlanPagerDocument(live),
              undefined,
              undefined,
              "force",
            );
            notify(services, "Plan detail", { key: "plan-detail", durationMs: 1200 });
          } else {
            notify(services, "No active plan yet", {
              key: "plan-detail",
              level: "warn",
            });
          }
        })();
        break;
      case "transcript.toggle-thinking":
        key.preventDefault();
        toggleThinking();
        break;
      case "transcript.toggle-output":
        key.preventDefault();
        toggleOutput();
        break;
      case "transcript.top":
        key.preventDefault();
        jumpChatTop();
        break;
      case "transcript.bottom":
        key.preventDefault();
        jumpChatBottom();
        break;
      case "transcript.page-up":
        key.preventDefault();
        transcriptScrollPort.scrollBy(-12);
        break;
      case "transcript.page-down":
        key.preventDefault();
        transcriptScrollPort.scrollBy(12);
        break;
      case "focus.next-region": {
        key.preventDefault();
        const regions = planRendered
          ? (["composer", "transcript", "plan"] as const)
          : (["composer", "transcript"] as const);
        services.focus.cycleRegion([...regions]);
        const next = services.focus.activeContext();
        notify(services, `Focus · ${next}`, {
          key: "focus",
          durationMs: 1100,
        });
        break;
      }
      default:
        break;
    }
  });

  const planPaneWidth =
    layout.plan.placement === "split"
      ? splitPlanW
      : widthBudget.overlayPlanWidth;
  const planPanel = planRendered ? (
      <PlanView
        theme={theme}
        plan={plan}
        services={services}
        width={planPaneWidth}
      />
    ) : null;

  const overlayRestTop = Math.max(1, Math.floor(height * 0.08));
  const overlayPaneHeight = Math.max(12, Math.floor(height * 0.72));
  const overlayAnimTop = paneSlideTop(
    panePresence.progress,
    overlayRestTop,
    overlayPaneHeight,
  );

  const composerFocused =
    overlay.kind === "none" &&
    focusContext === "composer" &&
    !contextLimitEditing;

  function clearEscapeCancellation(): void {
    lastEscape.current = 0;
    if (escapeCancelTimer.current) {
      clearTimeout(escapeCancelTimer.current);
      escapeCancelTimer.current = undefined;
    }
    escapeCancelArmedRef.current = false;
    setEscapeCancelArmed(false);
  }

  function armEscapeCancellation(now: number): void {
    lastEscape.current = now;
    if (escapeCancelTimer.current) clearTimeout(escapeCancelTimer.current);
    escapeCancelArmedRef.current = true;
    setEscapeCancelArmed(true);
    escapeCancelTimer.current = setTimeout(() => {
      lastEscape.current = 0;
      escapeCancelTimer.current = undefined;
      escapeCancelArmedRef.current = false;
      setEscapeCancelArmed(false);
    }, ESC_CANCEL_WINDOW_MS);
  }

  function handleEscapeCancellation(dismissed: boolean): void {
    const now = Date.now();
    if (
      lastEscapeHandledAt.current > 0 &&
      now - lastEscapeHandledAt.current < ESC_SAME_PRESS_MS
    ) {
      return;
    }
    lastEscapeHandledAt.current = now;
    const doublePress =
      lastEscape.current > 0 &&
      now - lastEscape.current < ESC_CANCEL_WINDOW_MS;
    const hasCancelableWork = services.cancel.hasCancelableWork();

    const action = escapeCancellationAction({
      dismissed,
      doublePress,
      hasCancelableWork,
    });

    if (action === "dismiss") {
      clearEscapeCancellation();
      notify(services, "Closed · Esc", {
        key: "escape-dismiss",
        durationMs: 1000,
      });
      return;
    }

    if (action === "cancel-all") {
      clearEscapeCancellation();
      services.overlay.cancelBlockingPrompt();
      void services.cancel.cancelAll().then((outcome) => {
        clearEscapeCancellation();
        const text = outcome.ok
          ? "Cancelled turn and Responder jobs"
          : "Cancellation completed with job stop failures — open Jobs for details";
        if (outcome.ok) {
          notify(services, text, {
            key: "escape-cancel-all",
            durationMs: 2400,
          });
        } else {
          notifyWarn(services, text, {
            key: "escape-cancel-all",
            durationMs: 3200,
          });
        }
      });
      return;
    }

    if (action === "arm") {
      armEscapeCancellation(now);
      notify(services, armedCancelHint(), {
        key: "escape-arm",
        durationMs: ESC_CANCEL_WINDOW_MS,
      });
      return;
    }

    clearEscapeCancellation();
  }

  function onAppWheel(event: MouseEvent): void {
    if (!event.scroll || overlay.kind !== "none") return;
    if (focusContext === "plan") return;
    event.preventDefault();
    event.stopPropagation();
    services.focus.focusRegion("transcript");
    const { direction, delta } = event.scroll;
    const step = Math.max(1, delta || 1) * 3;
    const dy =
      direction === "up" ? -step : direction === "down" ? step : 0;
    if (dy !== 0) transcriptScrollPort.scrollBy(dy);
  }

  function onPlanWheel(event: MouseEvent): void {
    if (!event.scroll) return;
    event.stopPropagation();
    services.focus.focusRegion("plan");
  }

  function onAppMouseDrag(event: MouseEvent): void {
    if (!event.isDragging || overlay.kind !== "none") return;
    transcriptScrollPort.updateAutoScroll(event.x, event.y);
  }

  function onAppMouseUp(): void {
    transcriptScrollPort.stopAutoScroll();
  }

  function toggleThinking(): void {
    services.transcript.toggleThinkingGlobal();
    const on = services.transcript.getState().expandThinkingGlobal;
    notify(services, on ? "Thinking expanded · ^T" : "Thinking collapsed · ^T", {
      key: "thinking",
      durationMs: 1500,
    });
  }

  function cycleMode(): void {
    const current = services.session.getState().mode;
    const target = nextMode(current);
    services.session.setMode(target);
    setDefaultMode(target);
    notify(
      services,
      `Mode · ${target.toUpperCase()} — ${modeSwitchSummary(target)} · ⇧⇥`,
      { key: "mode", level: "success", durationMs: 1800 },
    );
  }

  function toggleOutput(): void {
    services.transcript.toggleOutputGlobal();
    const on = services.transcript.getState().expandOutputGlobal;
    notify(services, on ? "Tool output expanded · ^O" : "Tool output collapsed · ^O", {
      key: "output",
      durationMs: 1500,
    });
  }

  function jumpChatTop(): void {
    transcriptScrollPort.scrollToTop();
    notify(services, "Chat · top · ^U", { key: "scroll", durationMs: 1200 });
  }

  function jumpChatBottom(): void {
    transcriptScrollPort.scrollToBottom();
    notify(services, "Chat · end · ^D", { key: "scroll", durationMs: 1200 });
  }

  function openShortcutsPager(): void {
    services.overlay.openPager(
      "Keyboard shortcuts",
      formatShortcutsReference(),
      undefined,
      undefined,
      "force",
    );
    notify(services, "Keyboard shortcuts", { key: "help", durationMs: 1200 });
  }

  function toggleTasksPane(): void {
    setPlanVisible((visible) => {
      const next = !visible;
      if (next && !services.plan.current()) {
        void services.plan
          .load(services.session.sessionId)
          .then((loaded) => {
            if (!loaded) {
              notify(services, "No tasks for this session yet", {
                key: "tasks",
                level: "warn",
              });
            }
          })
          .catch(() => undefined);
      }
      notify(
        services,
        next ? "Tasks shown · ^H" : "Tasks hidden · ^H",
        { key: "tasks", durationMs: 1400 },
      );
      return next;
    });
  }

  return (
    <TerminalDimensionsContext.Provider value={{ width, height }}>
    <box
      style={{
        width: terminalWidth,
        height,
        flexDirection: "column",
        backgroundColor: theme.background,
        position: "relative",
      }}
      onMouseScroll={onAppWheel}
      onMouseDrag={onAppMouseDrag}
      onMouseUp={onAppMouseUp}
      onMouseDragEnd={onAppMouseUp}
    >
      {}
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          width: "100%",
          height: "100%",
          paddingLeft: horizontalPadding,
          paddingRight: horizontalPadding,
        }}
      >
        <box style={{ flexGrow: 1, flexDirection: "row", width: "100%" }}>
          <box
            style={{
              width: chatContentWidth,
              flexGrow: splitPlanW > 0 || overlayPlanW > 0 ? 0 : 1,
              flexShrink: 1,
              backgroundColor: theme.background,
              paddingRight: planChatGap > 0 ? planChatGap : 0,
            }}
          >
            <TranscriptView
              services={services}
              theme={theme}
              focused={focusContext === "transcript" && overlay.kind === "none"}
              contentWidth={widthBudget.transcriptContentWidth}
              scrollRef={transcriptScrollRef}
            />
          </box>
          {layout.plan.placement === "split" && planRendered ? (
            <box
              title=" Tasks "
              titleColor={theme.inputBorder}
              border
              borderStyle="rounded"
              style={{
                width: splitPlanW,
                height: "100%",
                flexShrink: 0,
                borderColor: theme.inputBorder,
                backgroundColor: theme.statusBackground,
              }}
              onMouseDown={() => services.focus.focusRegion("plan")}
              onMouseScroll={onPlanWheel}
            >
              {planPanel}
            </box>
          ) : null}
        </box>

        {}
        <QueuePanel
          services={services}
          theme={theme}
          width={contentInnerWidth}
          onEdit={(text) => {
            setComposerSeed({ token: Date.now(), text });
            services.focus.focusRegion("composer");
          }}
        />

        {}
        <OverlayHost
          services={services}
          theme={theme}
          width={contentInnerWidth}
          height={height}
          docked
        />

        <ResponderPanel
          services={services}
          theme={theme}
          width={contentInnerWidth}
          blockingOverlay={
            overlay.kind === "secret" ||
            overlay.kind === "confirm" ||
            overlay.kind === "scope-editor" ||
            overlay.kind === "keys-editor"
          }
        />

        {}
        <ComposerEditor
          services={services}
          theme={theme}
          width={contentInnerWidth}
          height={composerMaxTextRows}
          focused={composerFocused}
          maxSuggestions={completionRows}
          running={session.running}
          inputSuspended={contextLimitEditing}
          onEscapeCancel={() => handleEscapeCancellation(false)}
          seedDraft={composerSeed}
        />

        <StatusLine
          session={services.session}
          mode={session.mode}
          theme={theme}
          activity={transcript.runningStatus}
          width={contentInnerWidth}
          hasActivePlan={Boolean(plan)}
          planVisible={planVisible}
          thinkingExpanded={transcript.expandThinkingGlobal}
          outputExpanded={transcript.expandOutputGlobal}
          onToggleThinking={toggleThinking}
          onToggleOutput={toggleOutput}
          onTogglePlan={toggleTasksPane}
          onJumpTop={jumpChatTop}
          onJumpBottom={jumpChatBottom}
          onCutDraft={composerActionPort.cut}
          onClearDraft={composerActionPort.clear}
          onOpenCommands={composerActionPort.openCommands}
          hasDraft={hasDraft}
          onCycleMode={cycleMode}
          cancelArmed={escapeCancelArmed}
          onRequestCancel={() => handleEscapeCancellation(false)}
          onContextLimitEditingStart={() => {
            setContextLimitEditing(true);
            services.focus.setInputCaptured(true);
            services.focus.focusRegion("composer");
          }}
          onFocusComposer={() => {
            setContextLimitEditing(false);
            services.focus.setInputCaptured(false);
            services.focus.focusRegion("composer");
          }}
        />
      </box>

      <TranscriptScrollbar
        scrollRef={transcriptScrollRef}
        theme={theme}
        followKey={followKey}
      />

      {layout.plan.placement === "overlay" &&
      widthBudget.showPlanOverlay ? (
        <box
          title=" Tasks "
          titleColor={theme.inputBorder}
          border
          borderStyle="rounded"
          style={{
            position: "absolute",
            top: overlayAnimTop,
            right: horizontalPadding,
            width: widthBudget.overlayPlanWidth,
            height: overlayPaneHeight,
            borderColor: theme.inputBorder,
            backgroundColor: theme.statusBackground,
            zIndex: 50,
          }}
          onMouseDown={() => services.focus.focusRegion("plan")}
          onMouseScroll={onPlanWheel}
        >
          {planPanel}
        </box>
      ) : null}
      {}
      <OverlayHost
        services={services}
        theme={theme}
        width={terminalWidth}
        height={height}
      />

      {}
      <ToastHost
        toast={services.toast}
        theme={theme}
        termWidth={terminalWidth}
        termHeight={height}
      />
    </box>
    </TerminalDimensionsContext.Provider>
  );
}

function layoutSupportsSplit(columns: number): boolean {
  return columns >= 120;
}
