/** @jsxImportSource @opentui/react */
/**
 * Chrome under the composer.
 *
 * Idle: centered clickable chips (`/:commands`, Ctrl+T/O/H) with hover feedback.
 * Running: spinner + activity · Esc:cancel.
 * Scroll remainder badges (`▲ N` / `▼ N`) sit on the far right.
 */

import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { SessionController } from "../../../app/controllers/session-controller.js";
import type { Theme } from "../../rendering/theme.js";
import { useSessionState } from "../../state/use-session-state.js";
import {
  EMPTY_SCROLL_METRICS,
  transcriptScrollPort,
  type ScrollMetrics,
} from "../transcript/transcript-scroll-port.js";

export interface StatusLineProps {
  readonly session: SessionController;
  readonly theme: Theme;
  readonly activity: string | undefined;
  readonly width: number;
  readonly planVisible: boolean;
  readonly thinkingExpanded?: boolean | undefined;
  readonly outputExpanded?: boolean | undefined;
  /** Click Ctrl+T chip → toggle thinking. */
  readonly onToggleThinking?: (() => void) | undefined;
  /** Click Ctrl+O chip → toggle tool/compacted output. */
  readonly onToggleOutput?: (() => void) | undefined;
  /** Click Ctrl+H chip → toggle plan pane. */
  readonly onTogglePlan?: (() => void) | undefined;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function clip(value: string, max: number): string {
  if (max <= 1) return "…";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapse router/agent status noise into a single clean activity phrase. */
function formatActivity(activity: string | undefined, elapsedSec: number): string {
  let base = (activity ?? "waiting for model").replace(/\s+/g, " ").trim() || "working";
  base = base.replace(/^[⏳·•\s]+/, "").replace(/\n/g, " ").trim();
  if (/rate limited|retrying in/i.test(base) && !base.startsWith("⏳")) {
    base = `⏳ ${base}`;
  }
  return `${base} · ${elapsedSec}s`;
}

function sep(theme: Theme): ReactNode {
  return <text selectable={false} content="  │  " style={{ fg: theme.muted }} />;
}

/** Far-right amber remaining-line badges. */
function ScrollRemainderBadges(props: {
  theme: Theme;
  metrics: ScrollMetrics;
}): ReactNode {
  const { theme, metrics } = props;
  if (metrics.linesAbove <= 0 && metrics.linesBelow <= 0) return null;
  return (
    <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
      {metrics.linesAbove > 0 ? (
        <>
          <text selectable={false} content=" " />
          <text
            selectable={false}
            content={` ▲ ${metrics.linesAbove} `}
            style={{
              fg: theme.white,
              bg: theme.queued,
              attributes: TextAttributes.BOLD,
            }}
          />
        </>
      ) : null}
      {metrics.linesBelow > 0 ? (
        <>
          <text selectable={false} content=" " />
          <text
            selectable={false}
            content={` ▼ ${metrics.linesBelow} `}
            style={{
              fg: theme.white,
              bg: theme.queued,
              attributes: TextAttributes.BOLD,
            }}
          />
        </>
      ) : null}
    </box>
  );
}

/**
 * Clickable status chip — idle is muted; hover gets a filled chip so the
 * user can see it is interactive; active (toggled on) stays cyan/bold.
 *
 * Always `selectable={false}` + preventDefault on mouse-down so a click
 * toggles without starting a drag-selection of the label text.
 */
function ClickableHint(props: {
  label: string;
  active: boolean;
  theme: Theme;
  onClick?: (() => void) | undefined;
}): ReactNode {
  const { label, active, theme, onClick } = props;
  const [hovered, setHovered] = useState(false);

  // Hover: inverse chip (white on selection). Active: cyan bold. Idle: muted.
  const fg = hovered
    ? theme.white
    : active
      ? theme.cyan
      : theme.muted;
  const bg = hovered ? theme.selection : theme.background;
  const attributes =
    hovered || active ? TextAttributes.BOLD : TextAttributes.NONE;

  return (
    <box
      onMouseDown={(event) => {
        // Block OpenTUI selection before it claims the press.
        event.preventDefault();
        event.stopPropagation();
        onClick?.();
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        backgroundColor: bg,
      }}
    >
      <text
        selectable={false}
        content={hovered ? ` ${label} ` : label}
        style={{
          fg,
          bg,
          attributes,
        }}
      />
    </box>
  );
}

export function StatusLine(props: StatusLineProps): ReactNode {
  const {
    session,
    theme,
    activity,
    width,
    planVisible,
    thinkingExpanded = false,
    outputExpanded = false,
    onToggleThinking,
    onToggleOutput,
    onTogglePlan,
  } = props;
  const state = useSessionState(session);
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>(
    EMPTY_SCROLL_METRICS,
  );

  const queued = state.queued.length;
  const compact = width < 56;
  const busy = state.running || state.compacting;

  useEffect(() => transcriptScrollPort.onMetrics(setScrollMetrics), []);

  useEffect(() => {
    if (!busy) {
      setFrame(0);
      setElapsed(0);
      setStartedAt(undefined);
      return;
    }
    const origin = Date.now();
    setStartedAt(origin);
    setElapsed(0);
    const spinner = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      100,
    );
    const clock = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    }, 250);
    return () => {
      clearInterval(spinner);
      clearInterval(clock);
    };
  }, [busy, state.compacting, state.running]);

  useEffect(() => {
    if (!busy || startedAt === undefined) return;
    setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  }, [busy, startedAt, activity]);

  if (busy) {
    const activityText = state.compacting
      ? `compacting conversation · ${elapsed}s`
      : formatActivity(activity, elapsed);
    const activityMax = Math.max(14, width - (compact ? 28 : 40));
    return (
      <box
        style={{
          flexDirection: "row",
          width: "100%",
          height: 1,
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: theme.background,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 1 }}>
          <text
            selectable={false}
            content={`${SPINNER_FRAMES[frame]} `}
            style={{ fg: theme.spinner }}
          />
          <text
            selectable={false}
            content={clip(activityText, activityMax)}
            style={{ fg: theme.activity }}
          />
        </box>
        <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
          {queued > 0 ? (
            <text
              selectable={false}
              content={`${queued} queued  `}
              style={{ fg: theme.mode }}
            />
          ) : null}
          {state.compacting ? (
            <text selectable={false} content="COMPACTING" style={{ fg: theme.mode }} />
          ) : (
            <text selectable={false} content="Esc:cancel" style={{ fg: theme.muted }} />
          )}
          <ScrollRemainderBadges theme={theme} metrics={scrollMetrics} />
        </box>
      </box>
    );
  }

  // Idle: centered chips; scroll ▲/▼ flush right.
  // Three columns (flexGrow left + center + flexGrow right) keep the middle true-center.
  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: 1,
        alignItems: "center",
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {/* Left balance spacer (mirrors right so center stays centered). */}
      <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }} />

      {/* Centered shortcut chips */}
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
          justifyContent: "center",
        }}
      >
        <text selectable={false} content="/:commands" style={{ fg: theme.muted }} />
        {!compact ? (
          <>
            {sep(theme)}
            <ClickableHint
              label={thinkingExpanded ? "Ctrl+T:thinking on" : "Ctrl+T:thinking"}
              active={thinkingExpanded}
              theme={theme}
              onClick={onToggleThinking}
            />
            {sep(theme)}
            <ClickableHint
              label={outputExpanded ? "Ctrl+O:output on" : "Ctrl+O:output"}
              active={outputExpanded}
              theme={theme}
              onClick={onToggleOutput}
            />
          </>
        ) : null}
        {width >= 72 ? (
          <>
            {sep(theme)}
            <ClickableHint
              label={planVisible ? "Ctrl+H:plan on" : "Ctrl+H:plan"}
              active={planVisible}
              theme={theme}
              onClick={onTogglePlan}
            />
          </>
        ) : null}
        {queued > 0 ? (
          <>
            {sep(theme)}
            <text
              selectable={false}
              content={`${queued} queued`}
              style={{ fg: theme.mode }}
            />
          </>
        ) : null}
      </box>

      {/* Right: scroll remainder badges */}
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          flexDirection: "row",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <ScrollRemainderBadges theme={theme} metrics={scrollMetrics} />
      </box>
    </box>
  );
}
