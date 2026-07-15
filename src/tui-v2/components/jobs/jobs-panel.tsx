/** @jsxImportSource @opentui/react */
/**
 * Background jobs overlay (CORE-004, V2-075). Jobs live in the core job
 * manager and survive UI rerenders (`JobController` only observes/commands);
 * this component polls for live status since jobs are not event-driven, and
 * exceeds the classic TUI's list-only panel by routing "tail" through the
 * pager instead of leaving output to a separate agent tool call.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { BackgroundJob } from "../../../app/ports/jobs-port.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";

export interface JobsPanelProps {
  readonly services: AppServices;
  readonly theme: Theme;
}

const HUNG_AFTER_MS = 120_000;
const POLL_MS = 1000;

function statusView(job: BackgroundJob, theme: Theme): { text: string; fg: string } {
  if (job.status === "running") {
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    return elapsed > HUNG_AFTER_MS
      ? { text: "running (possibly hung)", fg: theme.accent }
      : { text: "running", fg: theme.foreground };
  }
  if (job.status === "exited") {
    return { text: `exited (${job.exitCode ?? "?"})`, fg: job.exitCode ? theme.accent : theme.muted };
  }
  return { text: job.status, fg: theme.accent };
}

function elapsedLabel(job: BackgroundJob): string {
  const end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
  return `${Math.round((end - new Date(job.startedAt).getTime()) / 1000)}s`;
}

export function JobsPanel(props: JobsPanelProps): ReactNode {
  const { services, theme } = props;
  const [jobs, setJobs] = useState<BackgroundJob[]>(() => services.ports.jobs.running());
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => {
    const interval = setInterval(() => setJobs(services.ports.jobs.running()), POLL_MS);
    return () => clearInterval(interval);
  }, [services.ports.jobs]);

  async function tail(job: BackgroundJob): Promise<void> {
    const result = await services.ports.jobs.tail(job.id);
    services.overlay.close();
    services.overlay.openPager(`${job.command} · tail`, result.output);
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
          const result = services.ports.jobs.stop(job.id);
          setNote(result.output);
          setJobs(services.ports.jobs.running());
        }
        break;
      case "jobs.tail":
        if (job) void tail(job);
        break;
      case "jobs.close":
        services.overlay.close();
        break;
      default:
        break;
    }
  });

  return (
    <box
      style={{
        flexDirection: "column",
        width: "70%",
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text style={{ fg: theme.accent }}>Background jobs</text>
      <text style={{ fg: theme.muted }}>↑↓:select  ·  enter/t:tail  ·  k:kill  ·  q/esc:close</text>
      <text style={{ fg: theme.border }}>{"─".repeat(40)}</text>
      <text content=" " />
      {jobs.length === 0 ? (
        <text style={{ fg: theme.muted }}>no background jobs</text>
      ) : (
        jobs.map((job, index) => {
          const status = statusView(job, theme);
          const focused = index === selected;
          return (
            <box key={job.id} onMouseDown={() => setSelected(index)} style={{ flexDirection: "row" }}>
              <text style={{ fg: focused ? theme.accent : theme.foreground }}>
                {focused ? "❯ " : "  "}
                [{job.id}] <span style={{ fg: status.fg }}>{status.text}</span>{"  "}
                {elapsedLabel(job)}  {job.command.slice(0, 48)}
              </text>
            </box>
          );
        })
      )}
      {note ? <text style={{ fg: theme.muted }}>{note}</text> : null}
    </box>
  );
}
