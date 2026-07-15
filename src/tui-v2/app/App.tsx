/** @jsxImportSource @opentui/react */
/**
 * Responsive v2 shell (V2-032, Phase 7 plan/overlay host).
 *
 * Legacy-style layout: scrollable transcript (intro card + messages), optional
 * plan, completion menu + composer at the bottom, OverlayHost for pickers.
 *
 * Overlays (Ctrl+P pager, pickers, modals) live in a full-bleed absolute host
 * outside the padded content column so they never reflow or clip the intro
 * card. Plan split/overlay reserves chat width so the agent card stays intact.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { MouseEvent } from "@opentui/core";
import {
  COMPOSER_MAX_HEIGHT,
  MIN_CHAT_ROWS,
  computeLayout,
} from "../layout/compute-layout.js";
import { ComposerEditor } from "../composer/composer-editor.js";
import { maxComposerTextRows } from "../composer/composer-height.js";
import { TranscriptView } from "../components/transcript/transcript-view.js";
import { PlanView } from "../components/plan/plan-view.js";
import { OverlayHost } from "../components/overlay/overlay-host.js";
import { QueuePanel } from "../components/queue/queue-panel.js";
import { chordFromKeyEvent } from "../actions/chord-from-key.js";
import { usePlan } from "../state/use-plan.js";
import { useOverlayState } from "../state/use-overlay.js";
import { useTranscriptState } from "../state/use-transcript-store.js";
import { useSessionState } from "../state/use-session-state.js";
import type { CommandHelpEntry } from "../../app/commands/registry.js";
import { useServices, useTheme } from "./providers.js";
import { promptPlanApprovalIfNeeded } from "./plan-lifecycle.js";
import { StatusLine } from "../components/status/status-line.js";
import { ToastHost } from "../components/toast/toast-host.js";
import { transcriptScrollPort } from "../components/transcript/transcript-scroll-port.js";

const CTRL_C_QUIT_WINDOW_MS = 1500;

/** Floating plan panel width — kept in sync with the overlay box style. */
function planOverlayWidth(termWidth: number): number {
  return Math.min(52, Math.max(34, Math.floor(termWidth * 0.4)));
}

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
  const seenPlanKey = useRef<string | undefined>(undefined);
  /** Seed the composer when the user clicks Edit on a queued prompt. */
  const [composerSeed, setComposerSeed] = useState<
    { token: number; text: string } | undefined
  >(undefined);

  useEffect(() => services.focus.onChange(setFocusContext), [services.focus]);

  useEffect(() => {
    return services.session.onTurnEnd((result) => {
      if (result.status === "completed") void promptPlanApprovalIfNeeded(services);
      // Drain "send now" priority + remaining queue after every settled turn
      // (including abort). Without this, queued prompts never auto-ran in v2.
      void services.session.continueQueue();
    });
  }, [services]);

  useEffect(() => {
    if (!plan) {
      seenPlanKey.current = undefined;
      return;
    }
    const key = `${plan.sessionId}:${plan.updatedAt}`;
    if (seenPlanKey.current === key) return;
    seenPlanKey.current = key;
    setPlanVisible(true);
  }, [plan]);

  const layout = computeLayout({
    columns: width,
    rows: height,
    planVisible,
    splitEnabled: layoutSupportsSplit(width),
  });

  // Budget for multi-line input growth (Shift+Enter / wrap). Layout still
  // prefers a single idle row; the editor expands within this cap.
  const composerMaxTextRows = maxComposerTextRows({
    terminalRows: height,
    statusHeight: layout.status.height,
    minChatRows: MIN_CHAT_ROWS,
    maxCap: COMPOSER_MAX_HEIGHT,
  });

  const session = useSessionState(services.session);
  const horizontalPadding = width >= 56 ? 2 : width >= 28 ? 1 : 0;
  const completionRows = Math.max(6, Math.min(12, Math.floor(height / 3)));

  // Chat pane column budget (inside padded shell). Plan split and floating
  // overlay both shrink this so the intro card + messages reflow cleanly
  // instead of overflowing mid-border under Ctrl+H.
  const contentInnerWidth = Math.max(10, width - horizontalPadding * 2);
  const splitPlanW =
    planVisible && layout.plan.placement === "split" ? layout.plan.width + 1 : 0;
  const overlayPlanW =
    planVisible && layout.plan.placement === "overlay" ? planOverlayWidth(width) + 2 : 0;
  const chatContentWidth = Math.max(24, contentInnerWidth - splitPlanW - overlayPlanW);

  useKeyboard((key) => {
    if (key.eventType === "release" || overlay.kind !== "none") return;

    const chord = chordFromKeyEvent(key);
    // Tab belongs to the completion menu while the composer is active. The
    // previous global focus binding consumed it first, which made `/mod` + Tab
    // appear to freeze the input instead of completing `/model`.
    if (focusContext === "composer" && chord === "tab") return;
    const action = services.router.resolve(chord, focusContext);
    if (!action) return;
    switch (action) {
      case "app.cancel":
        // Esc: abort a live turn only. Never exit — multi-Esc used to quit
        // because it shared the double-press path with Ctrl+C.
        key.preventDefault();
        if (services.session.getState().running) {
          services.session.abort();
        }
        break;
      case "app.interrupt": {
        // Ctrl+C: first press aborts if running (and arms quit); second press
        // within the window exits. Idle: first arms, second exits.
        key.preventDefault();
        const now = Date.now();
        if (services.session.getState().running) {
          services.session.abort();
          lastCtrlC.current = now;
          services.session.notice(
            "info",
            "turn aborted · Ctrl+C again to exit",
          );
          break;
        }
        if (
          lastCtrlC.current > 0 &&
          now - lastCtrlC.current < CTRL_C_QUIT_WINDOW_MS
        ) {
          services.requestExit();
        } else {
          lastCtrlC.current = now;
          services.session.notice("info", "Ctrl+C again to exit");
        }
        break;
      }
      case "app.quit":
        key.preventDefault();
        services.requestExit();
        break;
      case "app.toggle-plan":
        key.preventDefault();
        // If the panel is about to open and we have no in-memory plan, try
        // loading the plan for this session from disk (history resume, or
        // plan created before a restart).
        setPlanVisible((v) => {
          const next = !v;
          if (next && !services.plan.current()) {
            void services.plan
              .load(services.session.sessionId)
              .then((loaded) => {
                if (!loaded) {
                  services.session.notice(
                    "info",
                    "no plan for this session yet",
                  );
                }
              })
              .catch(() => undefined);
          }
          return next;
        });
        break;
      case "app.jobs":
        key.preventDefault();
        services.overlay.openJobs();
        break;
      case "app.help":
        key.preventDefault();
        services.overlay.openPager("Commands", formatHelp(services.commands.help()));
        break;
      case "plan.toggle-detail":
        key.preventDefault();
        // Ctrl+P: full plan detail pager. Reload from disk if memory is empty
        // (e.g. after /history resume before the plan controller was refreshed).
        void (async () => {
          let live = services.plan.current() ?? plan;
          if (!live) {
            live = await services.plan
              .load(services.session.sessionId)
              .catch(() => undefined);
          }
          if (live) {
            const { formatPlanPagerDocument } = await import(
              "../rendering/plan-view.js"
            );
            services.overlay.openPager(
              `Plan · ${live.goal}`,
              formatPlanPagerDocument(live),
            );
          } else {
            services.session.notice(
              "info",
              "no active plan yet — Ctrl+P views plan detail",
            );
          }
        })();
        break;
      case "transcript.toggle-thinking":
        key.preventDefault();
        services.transcript.toggleThinkingGlobal();
        break;
      case "transcript.toggle-output":
        key.preventDefault();
        services.transcript.toggleOutputGlobal();
        break;
      case "focus.next-region":
        key.preventDefault();
        services.focus.cycleRegion(
          planVisible && layout.plan.placement !== "hidden"
            ? ["composer", "transcript", "plan"]
            : ["composer", "transcript"],
        );
        break;
      default:
        break;
    }
  });

  const planPaneWidth =
    layout.plan.placement === "split"
      ? layout.plan.width
      : planOverlayWidth(width);
  const planPanel =
    planVisible && layout.plan.placement !== "hidden" ? (
      <PlanView
        theme={theme}
        plan={plan}
        services={services}
        width={planPaneWidth}
      />
    ) : null;

  // Composer only owns the keyboard when the focus region is composer.
  // Clicking the transcript leaves focus there so ↑/↓ scroll the chat instead
  // of walking prompt history in the textarea.
  const composerFocused = overlay.kind === "none" && focusContext === "composer";

  /**
   * Wheel/trackpad outside focused regions that own their own scroll (plan
   * pane, overlays) scrolls the chat. Plan wheel handlers stopPropagation so
   * this does not also move the transcript when scrolling tasks.
   */
  function onAppWheel(event: MouseEvent): void {
    if (!event.scroll || overlay.kind !== "none") return;
    // Plan pane owns its ScrollBox — never steal its wheel into chat.
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

  /** Plan pane wheel: claim focus + stop bubble so chat does not scroll too. */
  function onPlanWheel(event: MouseEvent): void {
    if (!event.scroll) return;
    event.stopPropagation();
    services.focus.focusRegion("plan");
    // Native ScrollBox under PlanView handles the actual list motion.
  }

  /** Keep chat edge-scrolling while drag-selecting even over composer/status. */
  function onAppMouseDrag(event: MouseEvent): void {
    if (!event.isDragging || overlay.kind !== "none") return;
    transcriptScrollPort.updateAutoScroll(event.x, event.y);
  }

  function onAppMouseUp(): void {
    transcriptScrollPort.stopAutoScroll();
  }

  return (
    <box
      style={{
        width,
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
      {/* Padded content column — overlays are siblings outside this box so
          absolute full-bleed hosts never inherit padding and clip chrome. */}
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
              // Explicit width so OpenTUI does not let the plan panel steal
              // columns from under a flex-grown intro card mid-frame.
              width: chatContentWidth,
              flexGrow: layout.plan.placement === "split" || overlayPlanW > 0 ? 0 : 1,
              flexShrink: 1,
              backgroundColor: theme.background,
            }}
          >
            <TranscriptView
              services={services}
              theme={theme}
              focused={focusContext === "transcript" && overlay.kind === "none"}
              contentWidth={chatContentWidth}
            />
          </box>
          {layout.plan.placement === "split" ? (
            <box
              title=" Plan "
              border
              borderStyle="rounded"
              style={{
                width: layout.plan.width,
                height: "100%",
                flexShrink: 0,
                // CLAI wordmark top-of-"I" magenta (same as agent card frame).
                borderColor: theme.magenta,
                backgroundColor: theme.statusBackground,
              }}
              onMouseDown={() => services.focus.focusRegion("plan")}
              onMouseScroll={onPlanWheel}
            >
              {planPanel}
            </box>
          ) : null}
        </box>

        {/* Queued prompts (send after current turn; click Send now / Edit). */}
        <QueuePanel
          services={services}
          theme={theme}
          width={contentInnerWidth}
          onEdit={(text) => {
            setComposerSeed({ token: Date.now(), text });
            services.focus.focusRegion("composer");
          }}
        />

        {/* Completion menu + input live here; menu grows upward into flex space. */}
        <ComposerEditor
          services={services}
          theme={theme}
          width={contentInnerWidth}
          height={composerMaxTextRows}
          focused={composerFocused}
          maxSuggestions={completionRows}
          running={session.running}
          seedDraft={composerSeed}
        />

        {layout.status.height > 0 ? (
          <StatusLine
            session={services.session}
            theme={theme}
            activity={transcript.runningStatus}
            width={contentInnerWidth}
            planVisible={planVisible}
            thinkingExpanded={transcript.expandThinkingGlobal}
            outputExpanded={transcript.expandOutputGlobal}
            onToggleThinking={() => services.transcript.toggleThinkingGlobal()}
            onToggleOutput={() => services.transcript.toggleOutputGlobal()}
            onTogglePlan={() => {
              // Same path as Ctrl+H — open loads plan from disk when empty.
              setPlanVisible((v) => {
                const next = !v;
                if (next && !services.plan.current()) {
                  void services.plan
                    .load(services.session.sessionId)
                    .then((loaded) => {
                      if (!loaded) {
                        services.session.notice(
                          "info",
                          "no plan for this session yet",
                        );
                      }
                    })
                    .catch(() => undefined);
                }
                return next;
              });
            }}
          />
        ) : null}
      </box>

      {layout.plan.placement === "overlay" && planVisible ? (
        <box
          title=" Plan "
          border
          borderStyle="rounded"
          style={{
            position: "absolute",
            top: Math.max(1, Math.floor(height * 0.08)),
            // Sit in the reserved right gutter so it never paints over the
            // reflowed intro card / chat column.
            right: Math.max(1, horizontalPadding),
            width: planOverlayWidth(width),
            height: Math.max(12, Math.floor(height * 0.72)),
            // CLAI wordmark top-of-"I" magenta (same as agent card frame).
            borderColor: theme.magenta,
            backgroundColor: theme.statusBackground,
            zIndex: 50,
          }}
          onMouseDown={() => services.focus.focusRegion("plan")}
          onMouseScroll={onPlanWheel}
        >
          {planPanel}
        </box>
      ) : null}

      {/* Full-bleed overlay host (pickers, Ctrl+P pager, prompt actions, …).
          Sibling of the padded column so open/close never reflows the intro. */}
      <OverlayHost services={services} theme={theme} width={width} height={height} />

      {/* Right-edge copy/status toasts — outside padded column so they never
          reflow chat; z-index above plan overlay, below blocking overlays. */}
      <ToastHost
        toast={services.toast}
        theme={theme}
        termWidth={width}
        termHeight={height}
      />
    </box>
  );
}

function layoutSupportsSplit(columns: number): boolean {
  return columns >= 120;
}

function formatHelp(entries: readonly CommandHelpEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.command}${e.usage ? ` ${e.usage}` : ""}  —  ${e.description}${
          e.aliases.length ? ` (aliases: ${e.aliases.join(", ")})` : ""
        }`,
    )
    .join("\n");
}
