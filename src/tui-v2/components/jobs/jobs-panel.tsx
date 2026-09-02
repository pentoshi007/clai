/** @jsxImportSource @opentui/react */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type {
  BackgroundJob,
  ResponderNotification,
} from "../../../app/ports/jobs-port.js";
import { formatJobElapsed } from "../../../tools/jobs.js";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import { useSessionState } from "../../../ui-core/react/use-session-state.js";
import { responderStatusText } from "../../../ui-core/rendering/status-segments.js";
import {
  createJobTailPagerSource,
  isLiveJobStatus,
  jobTailTitle,
} from "../../../ui-core/rendering/job-tail-source.js";

export interface JobsPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
}

const POLL_MS = 1000;
const RESPONDER_MAX_ROWS = 3;

function statusView(job: BackgroundJob, theme: Theme): { text: string; fg: string } {
  if (job.status === "running") {
    const heartbeatAge = job.heartbeatAt ? Date.now() - new Date(job.heartbeatAt).getTime() : undefined;
    return heartbeatAge !== undefined && heartbeatAge > 120_000
      ? { text: "running (quiet)", fg: theme.foreground }
      : { text: "running", fg: theme.foreground };
  }
  if (job.status === "exited") {
    return { text: `exited (${job.exitCode ?? "?"})`, fg: job.exitCode ? theme.accent : theme.muted };
  }
  if (job.status === "failed") {
    return { text: `failed (${job.exitCode ?? "?"})`, fg: theme.accent };
  }
  if (job.status === "killed") {
    const detail = [job.signal, job.exitCode].filter((value) => value !== undefined).join("/") || "?";
    return { text: `killed (${detail})`, fg: theme.accent };
  }
  return { text: job.status, fg: theme.accent };
}

function jobPhase(
  job: BackgroundJob,
  notification?: ResponderNotification,
): { glyph: string; label: string } {
  if (notification?.archivedAt) return { glyph: "◇", label: "archived" };
  if (notification?.readAt) return { glyph: "✓", label: "read" };
  if (notification?.deliveredAt && !notification.analyzedAt) {
    return { glyph: "→", label: "delivered" };
  }
  if (notification) {
    return notification.status === "exited"
      ? { glyph: "✓", label: "result ready" }
      : { glyph: "✗", label: "failed result" };
  }
  switch (job.status) {
    case "starting":
    case "running":
      return { glyph: "⟳", label: "running" };
    case "stopping":
      return { glyph: "⊗", label: "stopping" };
    case "exited":
      return { glyph: "✓", label: "exited" };
    case "failed":
      return { glyph: "✗", label: "failed" };
    case "killed":
      return { glyph: "✗", label: "killed" };
    default:
      return { glyph: "•", label: job.status };
  }
}

export function JobsPanel(props: JobsPanelProps): ReactNode {
  const { services, theme } = props;
  const sessionState = useSessionState(services.session);
  const readJobs = (): BackgroundJob[] => {
    const sessionId = services.session.sessionId;
    return (
      services.ports.jobs.recent?.(100, sessionId) ??
      services.ports.jobs.running(sessionId)
    );
  };
  const [jobs, setJobs] = useState<BackgroundJob[]>(readJobs);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState("");

  const hasLiveJob = jobs.some(
    (job) =>
      job.status === "running" ||
      job.status === "starting" ||
      job.status === "stopping",
  );

  useEffect(() => {
    const refresh = (): void => {
      setJobs(readJobs());
      setNow(Date.now());
    };
    refresh();
    const unsubscribe = services.ports.jobs.subscribe?.(refresh);
    const interval = hasLiveJob ? setInterval(refresh, POLL_MS) : undefined;
    return () => {
      unsubscribe?.();
      if (interval) clearInterval(interval);
    };
  }, [services.ports.jobs, services.session.sessionId, hasLiveJob]);

  async function tail(job: BackgroundJob): Promise<void> {
    const result = await services.ports.jobs.tail(job.id);
    services.overlay.close();
    services.overlay.openPager(`${job.command} · tail`, result.output);
  }

  function viewLive(job: BackgroundJob): void {
    const source = createJobTailPagerSource({
      jobs: services.ports.jobs,
      jobId: job.id,
    });
    if (!source) {
      setNote("This job has no output artifact to view.");
      return;
    }
    const opened = services.overlay.openPager(
      jobTailTitle(job.commandDisplay || job.command, isLiveJobStatus(job.status)),
      "",
      source,
    );
    if (!opened) {
      source.dispose();
      setNote("Could not open the output view.");
    }
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const action = services.router.resolve(chordFromKeyEvent(key), "jobs");
    if (!action) return;
    key.preventDefault();
    const job = jobs[Math.min(selected, Math.max(0, jobs.length - 1))];
    switch (action) {
      case "jobs.up":
        setSelected((s) => Math.max(0, s - 1));
        break;
      case "jobs.down":
        setSelected((s) => Math.min(Math.max(0, jobs.length - 1), s + 1));
        break;
      case "jobs.stop":
        if (job?.status === "running") {
          void services.ports.jobs.stop(job.id).then((result) => {
            setNote(result.output);
            setJobs(readJobs());
          });
        }
        break;
      case "jobs.tail":
        if (job) void tail(job);
        break;
      case "jobs.view-live":
        if (job) viewLive(job);
        break;
      case "jobs.close":
        services.overlay.close();
        break;
      default:
        break;
    }
  });

  const titleLine = `Background jobs · session ${services.session.sessionId}`;
  const helpLine =
    "up/down:select · enter/v:view live · t:snapshot · k:kill · q/esc:close";
  const notificationByJob = new Map(
    services.ports.jobs
      .pendingNotifications(services.session.sessionId)
      .map((notification) => [notification.jobId, notification]),
  );

  return (
    <box
      title={` ${titleLine} `}
      titleColor={theme.accent}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "82%",
        height: "80%",
        borderColor: theme.border,
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        content={helpLine}
        wrapMode="none"
        style={{
          fg: theme.muted,
          height: 1,
          width: "100%",
        }}
      />
      <text
        content={responderStatusText(sessionState.responder)}
        wrapMode="none"
        style={{
          fg:
            sessionState.responder.mode === "listening"
              ? theme.cyan
              : theme.muted,
          height: 1,
          width: "100%",
        }}
      />
      <text
        content={"─".repeat(Math.min(48, helpLine.length + 4))}
        wrapMode="none"
        style={{ fg: theme.border, height: 1, width: "100%" }}
      />
      <text content=" " wrapMode="none" style={{ height: 1 }} />
      {}
      <scrollbox scrollY scrollX={false} style={{ flexGrow: 1, width: "100%" }}>
      {jobs.length === 0 ? (
        <text
          content="no background jobs for this session"
          wrapMode="none"
          style={{ fg: theme.muted, height: 1 }}
        />
      ) : (
        jobs.map((job, index) => {
          const status = statusView(job, theme);
          const focused = index === selected;
          const notification = notificationByJob.get(job.id);
          const phase = jobPhase(job, notification);
          const kindTag = job.responder ? "responder" : "background";
          const linkage = [
            job.parentTaskId ? `parent=${job.parentTaskId}` : undefined,
            job.taskId ? `task=${job.taskId}` : undefined,
            `job=${job.id}`,
            job.pid ? `pid=${job.pid}` : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          const marker = focused ? "❯ " : "  ";
          const headline = `${marker}${phase.glyph} ${status.text} · ${phase.label}  ·  ${formatJobElapsed(job, now)}`;
          const meta = `    ${kindTag} · ${linkage}`;
          const command = job.name ? `${job.name}: ${job.command}` : job.command;
          return (
            <box
              key={job.id}
              onMouseDown={() => setSelected(index)}
              style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
            >
              <text
                content={headline}
                wrapMode="none"
                style={{
                  fg: focused ? theme.accent : status.fg,
                  height: 1,
                  width: "100%",
                  ...(focused ? { attributes: TextAttributes.BOLD } : {}),
                }}
              />
              <text
                content={meta}
                wrapMode="none"
                style={{ fg: theme.muted, height: 1, width: "100%" }}
              />
              <text
                content={`    ${command}`}
                wrapMode="word"
                style={{
                  fg: focused ? theme.foreground : theme.muted,
                  width: "100%",
                }}
              />
              <text content=" " wrapMode="none" style={{ height: 1 }} />
            </box>
          );
        })
      )}
      </scrollbox>
      {note ? (
        <text
          content={note}
          wrapMode="none"
          style={{ fg: theme.muted, height: 1 }}
        />
      ) : null}
    </box>
  );
}


export interface ResponderPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly blockingOverlay?: boolean | undefined;
}

interface ResponderProjection {
  jobs: BackgroundJob[];
  notifications: ResponderNotification[];
}

function readResponderProjection(services: AppServices): ResponderProjection {
  const sessionId = services.session.sessionId;
  const notifications = services.ports.jobs
    .pendingNotifications(sessionId)
    .filter((notification) => notification.responder);
  const live = services.ports.jobs
    .running(sessionId)
    .filter((job) => job.responder);
  const byId = new Map(live.map((job) => [job.id, job]));
  for (const notification of notifications) {
    const job = services.ports.jobs.get(notification.jobId);
    if (job) byId.set(job.id, job);
  }
  return {
    jobs: [...byId.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
    notifications,
  };
}

function responderStatusColor(job: BackgroundJob, theme: Theme): string {
  if (job.status === "running" || job.status === "starting") return theme.cyan;
  if (job.status === "exited") return theme.success;
  if (job.status === "stopping") return theme.queued;
  return theme.accent;
}

function responderHeadline(
  job: BackgroundJob,
  notification: ResponderNotification | undefined,
  now: number,
): string {
  const { glyph, label } = jobPhase(job, notification);
  const taskRef = job.taskId ? ` · task ${job.taskId}` : "";
  return `${glyph} ${label} · ${formatJobElapsed(job, now)}${taskRef}`;
}

export function ResponderPanel(props: ResponderPanelProps): ReactNode {
  const { services, theme, width, blockingOverlay } = props;
  const sessionState = useSessionState(services.session);
  const responderState = sessionState.responder;
  const [collapsed, setCollapsed] = useState(true);
  const [projection, setProjection] = useState(() =>
    readResponderProjection(services),
  );
  const [now, setNow] = useState(() => Date.now());

  const hasLiveWork = responderState.running > 0 || responderState.ready > 0;

  useEffect(() => {
    const refresh = (): void => {
      setProjection(readResponderProjection(services));
      setNow(Date.now());
    };
    refresh();
    const unsubscribe = services.ports.jobs.subscribe(refresh);
    const timer = hasLiveWork ? setInterval(refresh, POLL_MS) : undefined;
    return () => {
      unsubscribe();
      if (timer) clearInterval(timer);
    };
  }, [services.ports.jobs, services.session.sessionId, hasLiveWork]);

  const notificationByJob = useMemo(
    () =>
      new Map(
        projection.notifications.map((notification) => [
          notification.jobId,
          notification,
        ]),
      ),
    [projection.notifications],
  );
  const liveCount = responderState.running;
  const readyCount = responderState.ready;
  const sessionRunning = sessionState.running;
  const waiting =
    responderState.mode === "listening" &&
    !sessionRunning &&
    liveCount > 0 &&
    readyCount === 0;

  const waitingRef = useRef(false);
  useEffect(() => {
    if (waiting && !waitingRef.current) {
      services.toast.show(
        `Waiting on Responder · ${liveCount} job(s) running — analysis resumes automatically on completion`,
        { level: "info", key: "responder-waiting", durationMs: 2800 },
      );
    }
    waitingRef.current = waiting;
  }, [waiting, liveCount, services]);

  const hasActiveWork =
    responderState.running > 0 ||
    responderState.ready > 0 ||
    responderState.delivered > 0;
  if (
    blockingOverlay ||
    !hasActiveWork ||
    (projection.jobs.length === 0 && projection.notifications.length === 0)
  ) {
    return null;
  }

  const shown = projection.jobs.slice(0, RESPONDER_MAX_ROWS);
  const hidden = Math.max(0, projection.jobs.length - shown.length);
  const stateColor = responderState.ready > 0
    ? theme.success
    : responderState.mode === "listening"
      ? theme.cyan
      : responderState.archived > 0
        ? theme.queued
        : theme.muted;
  const statusText = responderStatusText(responderState).replace(
    /^Responder:\s*/,
    "",
  );
  const header = `${collapsed ? "▸" : "▾"} Responder: ${statusText}`;

  function toggle(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed((value) => !value);
  }

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width,
        flexShrink: 0,
        borderColor: stateColor,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        onMouseDown={toggle}
        style={{ width: "100%", height: 1, flexShrink: 0 }}
      >
        <text
          content={header}
          wrapMode="none"
          style={{
            width: "100%",
            height: 1,
            fg: stateColor,
            attributes: TextAttributes.BOLD,
          }}
        />
      </box>
      {!collapsed
        ? shown.map((job) => (
            <box
              key={job.id}
              onMouseDown={(event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                services.overlay.openJobs();
              }}
              style={{ flexDirection: "column", width: "100%", flexShrink: 0 }}
            >
              <text
                content={`  ${responderHeadline(job, notificationByJob.get(job.id), now)}`}
                wrapMode="none"
                style={{
                  width: "100%",
                  height: 1,
                  fg: responderStatusColor(job, theme),
                }}
              />
              <text
                content={`    ${(job.name ?? job.commandDisplay).replace(/\s+/g, " ").trim()}`}
                wrapMode="word"
                style={{ width: "100%", fg: theme.foreground }}
              />
            </box>
          ))
        : null}
      {!collapsed && hidden > 0 ? (
        <text
          content={`  +${hidden} more · press Ctrl+J for all ${projection.jobs.length} jobs (full command, artifacts, actions)`}
          wrapMode="none"
          style={{ width: "100%", height: 1, fg: theme.muted }}
        />
      ) : null}
    </box>
  );
}
