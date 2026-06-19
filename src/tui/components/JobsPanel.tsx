import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { jobManager, type BackgroundJob } from "../../tools/jobs.js";

export interface JobsPanelProps {
  jobs: BackgroundJob[];
  onClose: () => void;
}

const HUNG_AFTER_MS = 120_000;

function statusLabel(job: BackgroundJob): { text: string; color: string } {
  if (job.status === "running") {
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    if (elapsed > HUNG_AFTER_MS) {
      return { text: "running (possibly hung)", color: "yellow" };
    }
    return { text: "running", color: "green" };
  }
  if (job.status === "exited") {
    return { text: `exited (${job.exitCode ?? "?"})`, color: job.exitCode ? "red" : "gray" };
  }
  return { text: job.status, color: "red" };
}

function elapsed(job: BackgroundJob): string {
  const end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
  return `${Math.round((end - new Date(job.startedAt).getTime()) / 1000)}s`;
}

/**
 * Toggled panel (Ctrl+J) listing background jobs the agent detached. Lets the
 * user select a job and kill it (k). Read-only otherwise — tailing happens via
 * the agent's `jobs.tail` tool / artifact files.
 */
export function JobsPanel({ jobs, onClose }: JobsPanelProps) {
  const [selected, setSelected] = useState(0);
  const [note, setNote] = useState("");

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      onClose();
      return;
    }
    if (jobs.length === 0) return;
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSelected((s) => Math.min(jobs.length - 1, s + 1));
    else if (input === "k") {
      const job = jobs[Math.min(selected, jobs.length - 1)];
      if (job && job.status === "running") {
        const r = jobManager.stopJob(job.id);
        setNote(r.output);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text>
        <Text bold color="blue">
          Background jobs
        </Text>
        <Text dimColor>{"  (↑↓ select · k kill · q close)"}</Text>
      </Text>
      {jobs.length === 0 ? (
        <Text dimColor>{"  no background jobs"}</Text>
      ) : (
        jobs.map((job, i) => {
          const s = statusLabel(job);
          return (
            <Text key={job.id} {...(i === selected ? { color: "blue" as const } : {})}>
              {i === selected ? "❯ " : "  "}
              <Text dimColor>[{job.id}]</Text> <Text color={s.color}>{s.text}</Text>
              <Text dimColor>{`  ${elapsed(job)}  `}</Text>
              {job.command.slice(0, 48)}
            </Text>
          );
        })
      )}
      {note ? <Text dimColor>{"  "}{note}</Text> : null}
    </Box>
  );
}
