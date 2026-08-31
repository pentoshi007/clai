/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  TextAttributes,
  type MouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { safeCwd } from "../../../os/cwd.js";
import { renderColumns } from "../../../ui-core/rendering/text-width.js";
import type {
  SessionController,
} from "../../../app/controllers/session-controller.js";
import type { ResponderRuntimeState } from "../../../app/controllers/session-responder.js";
import type { Mode } from "../../../types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { ContextLimitChip } from "./context-limit-chip.js";
import {
  contextChipForDensity,
  type StatusDensity,
} from "../../../ui-core/rendering/context-limit.js";

import {
  SPINNER_FRAMES,
  armedCancelHint,
  busyCancelHint,
  clipSegment as clip,
  cwdViewportWidth,
  formatActivity,
  idleHintIds,
  modeIndicatorPresentation,
  responderStatusText,
  statusDensityForWidth,
  tasksToggleLabel,
  type IdleHintId,
  type ModeIndicatorPresentation,
  type StatusHint,
} from "../../../ui-core/rendering/status-segments.js";

import { useSessionState } from "../../../ui-core/react/use-session-state.js";

export interface StatusLineProps {
  readonly session: SessionController;
  readonly mode: Mode;
  readonly theme: Theme;
  readonly activity: string | undefined;
  readonly width: number;
  readonly hasActivePlan: boolean;
  readonly planVisible: boolean;
  readonly thinkingExpanded?: boolean | undefined;
  readonly outputExpanded?: boolean | undefined;
  readonly onToggleThinking?: (() => void) | undefined;
  readonly onToggleOutput?: (() => void) | undefined;
  readonly onTogglePlan?: (() => void) | undefined;
  readonly onJumpTop?: (() => void) | undefined;
  readonly onJumpBottom?: (() => void) | undefined;
  readonly onCutDraft?: (() => void) | undefined;
  readonly onClearDraft?: (() => void) | undefined;
  readonly onOpenCommands?: (() => void) | undefined;
  readonly hasDraft?: boolean | undefined;
  readonly onCycleMode?: (() => void) | undefined;
  readonly cancelArmed?: boolean | undefined;
  readonly onRequestCancel?: (() => void) | undefined;
  readonly onContextLimitEditingStart?: (() => void) | undefined;
  readonly onFocusComposer?: (() => void) | undefined;
}

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

function CwdViewport(props: {
  readonly content: string;
  readonly width: number;
  readonly theme: Theme;
}): ReactNode {
  const { content, width, theme } = props;
  const contentWidth = renderColumns(content);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, y: 0 });
  }, [content]);

  const onMouseScroll = (event: MouseEvent): void => {
    if (!event.scroll) return;
    event.preventDefault();
    event.stopPropagation();
    const scrollbox = scrollRef.current;
    if (!scrollbox) return;
    const { direction, delta } = event.scroll;
    const step = Math.max(1, delta || 1) * 3;
    const dx =
      direction === "up" || direction === "left"
        ? -step
        : direction === "down" || direction === "right"
          ? step
          : 0;
    if (dx === 0) return;
    const viewportWidth = scrollbox.viewport?.width ?? width;
    const max = Math.max(0, scrollbox.scrollWidth - viewportWidth);
    scrollbox.scrollTo({
      x: Math.max(0, Math.min(max, scrollbox.scrollLeft + dx)),
      y: 0,
    });
  };

  return (
    <scrollbox
      ref={scrollRef}
      scrollX
      scrollY={false}
      scrollbarOptions={HIDDEN_SCROLLBARS}
      verticalScrollbarOptions={HIDDEN_SCROLLBARS}
      horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
      onMouseScroll={onMouseScroll}
      style={{
        width,
        height: 1,
        flexShrink: 0,
        backgroundColor: theme.background,
      }}
    >
      <text
        selectable={false}
        content={content}
        style={{
          fg: theme.muted,
          width: Math.max(width, contentWidth),
          height: 1,
          flexShrink: 0,
        }}
      />
    </scrollbox>
  );
}

function sep(theme: Theme): ReactNode {
  return (
    <text
      selectable={false}
      content=" │ "
      style={{ fg: theme.muted, flexShrink: 0 }}
    />
  );
}

function ClickableHint(props: {
  readonly short: string;
  readonly expand?: string | undefined;
  readonly active: boolean;
  readonly theme: Theme;
  readonly onClick?: (() => void) | undefined;
  readonly accent?: boolean | undefined;
}): ReactNode {
  const { short, expand, active, theme, onClick, accent = false } = props;
  const full = expand ?? short;
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reveal = (): void => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
    }
    setHovered(true);
  };
  const scheduleHide = (): void => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setHovered(false);
      hideTimer.current = undefined;
    }, 300);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const shown = hovered;
  const fg = shown
    ? theme.white
    : active || accent
      ? theme.cyan
      : theme.muted;
  const bg = shown
    ? theme.selection
    : accent
      ? theme.chip
      : theme.background;
  const attributes =
    shown || active || accent ? TextAttributes.BOLD : TextAttributes.NONE;

  return (
    <box
      onMouseOver={reveal}
      onMouseOut={scheduleHide}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        backgroundColor: bg,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        content={shown ? full : short}
        style={{ fg, bg, attributes }}
      />
    </box>
  );
}


function ModeBadge(props: {
  mode: Mode;
  theme: Theme;
}): ReactNode {
  const { mode, theme } = props;
  const label = modeIndicatorPresentation(mode).label;
  const bg =
    mode === "plan"
      ? theme.mode
      : mode === "ask"
        ? theme.chipIndigo
        : theme.chipTeal;
  return (
    <text
      selectable={false}
      content={` ${label} `}
      style={{
        fg: theme.white,
        bg,
        attributes: TextAttributes.BOLD,
        flexShrink: 0,
      }}
    />
  );
}

export function StatusLine(props: StatusLineProps): ReactNode {
  const {
    session,
    mode,
    theme,
    activity,
    width,
    hasActivePlan,
    planVisible,
    thinkingExpanded = false,
    outputExpanded = false,
    onToggleThinking,
    onToggleOutput,
    onTogglePlan,
    onJumpTop,
    onJumpBottom,
    onCutDraft,
    onClearDraft,
    onOpenCommands,
    hasDraft = false,
    onCycleMode,
    cancelArmed = false,
    onRequestCancel,
    onContextLimitEditingStart,
    onFocusComposer,
  } = props;
  const state = useSessionState(session);
  const [frame, setFrame] = useState(0);

  const [cwdDisplay, setCwdDisplay] = useState(() => {
    const cwd = safeCwd();
    const home = homedir();
    return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  });
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      const currentCwd = safeCwd();
      const home = homedir();
      const display = currentCwd.startsWith(home)
        ? `~${currentCwd.slice(home.length)}`
        : currentCwd;
      const branch = await new Promise<string | undefined>((resolve) => {
        execFile(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: currentCwd, timeout: 1500, encoding: "utf8" },
          (err, stdout) => {
            if (err) { resolve(undefined); return; }
            const b = stdout.trim();
            resolve(b || undefined);
          },
        );
      });
      if (cancelled) return;
      setCwdDisplay(display);
      setGitBranch(branch);
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const queued = state.queued.length;
  const density = statusDensityForWidth(width);
  const cwdWidth = cwdViewportWidth(
    width,
    density,
    renderColumns(cwdDisplay),
  );
  const busy = state.running || state.compacting;
  const showTasks = (hasActivePlan || planVisible) && density !== "xs";

  useEffect(() => {
    if (!busy) {
      setFrame(0);
      return;
    }
    const spinner = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      100,
    );
    return () => {
      clearInterval(spinner);
    };
  }, [busy]);

  const ctxChip = contextChipForDensity(state.contextUsage, density);
  const idleHints = idleHintIds(density, hasDraft);

  if (busy) {
    const activityMax =
      density === "xs"
        ? 0
        : density === "sm"
          ? Math.max(8, width - 40)
          : Math.max(12, width - 52);
    const activityText =
      density === "xs"
        ? undefined
        : state.compacting
          ? "compacting"
          : formatActivity(activity, activityMax);

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
        <box
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <ModeBadge mode={mode} theme={theme} />
          {sep(theme)}
          <text
            selectable={false}
            content={`${SPINNER_FRAMES[frame]} `}
            style={{ fg: theme.spinner, flexShrink: 0 }}
          />
          {activityText ? (
            <text
              selectable={false}
              content={clip(activityText, activityMax)}
              style={{ fg: theme.activity, flexShrink: 1 }}
            />
          ) : null}
          {cancelArmed || (density !== "xs" && !state.compacting) ? (
            <>
              {sep(theme)}
              <ClickableHint
                short={cancelArmed ? armedCancelHint() : busyCancelHint(density).short}
                expand={cancelArmed ? armedCancelHint() : busyCancelHint(density).expand}
                active={cancelArmed}
                theme={theme}
                accent
                onClick={onRequestCancel}
              />
            </>
          ) : null}
          {showTasks ? (
            <>
              {sep(theme)}
              <ClickableHint
                short={tasksToggleLabel(planVisible, density)}
                expand="Tasks"
                active={planVisible}
                theme={theme}
                onClick={onTogglePlan}
              />
            </>
          ) : null}
          {queued > 0 && density !== "xs" ? (
            <>
              {sep(theme)}
              <text
                selectable={false}
                content={`${queued}q`}
                style={{ fg: theme.mode, flexShrink: 0 }}
              />
            </>
          ) : null}
        </box>
        <box
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexShrink: 0,
            justifyContent: "flex-end",
          }}
        >
          {cwdWidth > 0 ? (
            <CwdViewport
              content={cwdDisplay}
              width={cwdWidth}
              theme={theme}
            />
          ) : null}
          {gitBranch ? (
            <text
              selectable={false}
              content={` \ue0a0 ${gitBranch}`}
              style={{ fg: theme.userBorder, flexShrink: 0, paddingRight: 2 }}
            />
          ) : null}
          {ctxChip && state.contextUsage ? (
            <ContextLimitChip
              chip={ctxChip}
              theme={theme}
              exact={state.contextUsage.exact}
              usage={state.contextUsage}
              session={session}
              onEditingStart={onContextLimitEditingStart}
              onEditingDone={onFocusComposer}
            />
          ) : null}
        </box>
      </box>
    );
  }


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
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 1,
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <ModeBadge mode={mode} theme={theme} />
        {cancelArmed ? (
          <>
            {sep(theme)}
            <ClickableHint
              short={armedCancelHint()}
              expand={armedCancelHint()}
              active
              theme={theme}
              accent
              onClick={onRequestCancel}
            />
          </>
        ) : null}

        {}
        {density !== "xs" ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="⇧⇥"
              expand="cycle mode"
              active={false}
              theme={theme}
              onClick={onCycleMode}
            />
          </>
        ) : null}

        {idleHints.includes("commands") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="/"
              expand="/ commands"
              active={false}
              theme={theme}
              onClick={onOpenCommands}
            />
          </>
        ) : null}
        {idleHints.includes("cut-draft") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^X"
              expand="cut draft (copy + clear)"
              active={false}
              theme={theme}
              onClick={onCutDraft}
            />
          </>
        ) : null}
        {idleHints.includes("clear-draft") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^Q"
              expand="clear draft"
              active={false}
              theme={theme}
              onClick={onClearDraft}
            />
          </>
        ) : null}
        {idleHints.includes("thinking") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^T"
              expand={thinkingExpanded ? "hide thinking" : "show thinking"}
              active={thinkingExpanded}
              theme={theme}
              onClick={onToggleThinking}
            />
          </>
        ) : null}
        {idleHints.includes("output") ? (
          <>
            {sep(theme)}
            <ClickableHint
              short="^O"
              expand={outputExpanded ? "hide output" : "show output"}
              active={outputExpanded}
              theme={theme}
              onClick={onToggleOutput}
            />
          </>
        ) : null}

        {showTasks ? (
          <>
            {sep(theme)}
            <ClickableHint
              short={tasksToggleLabel(planVisible, density)}
              expand="Tasks"
              active={planVisible}
              theme={theme}
              onClick={onTogglePlan}
            />
          </>
        ) : null}

        {queued > 0 && density !== "xs" ? (
          <>
            {sep(theme)}
            <text
              selectable={false}
              content={density === "sm" ? `${queued}q` : `${queued} queued`}
              style={{ fg: theme.mode, flexShrink: 0 }}
            />
          </>
        ) : null}
      </box>

      {}
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
          justifyContent: "flex-end",
        }}
      >
        {cwdWidth > 0 ? (
          <CwdViewport
            content={cwdDisplay}
            width={cwdWidth}
            theme={theme}
          />
        ) : null}
        {gitBranch ? (
          <text
            selectable={false}
            content={` \ue0a0 ${gitBranch}`}
            style={{ fg: theme.userBorder, flexShrink: 0, paddingRight: 2 }}
          />
        ) : null}
        {ctxChip && state.contextUsage ? (
          <ContextLimitChip
            chip={ctxChip}
            theme={theme}
            exact={state.contextUsage.exact}
            usage={state.contextUsage}
            session={session}
            onEditingStart={onContextLimitEditingStart}
            onEditingDone={onFocusComposer}
          />
        ) : null}
      </box>
    </box>
  );
}
