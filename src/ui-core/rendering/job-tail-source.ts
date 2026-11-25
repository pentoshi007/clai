import { watchFile, unwatchFile } from "node:fs";
import type { BackgroundJob, JobsPort } from "../../app/ports/jobs-port.js";
import { redactSecrets } from "../../llm/provider.js";
import { jobStdoutPrelude } from "../../tools/jobs/helpers.js";
import { pagerCommandTone } from "./pager-regions.js";
import {
  createArtifactPagerSource,
  createBytePagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPage,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";
import { createJobLogView, type JobLogFile } from "./job-log-view.js";

type JobStream = "stdout" | "stderr";

export interface JobTailSourceOptions {
  readonly jobs: JobsPort;
  readonly jobId: string;
  readonly stream?: JobStream | "combined";
  readonly pageBytes?: number;
  readonly hideCommandEcho?: boolean;
}

const LIVE_STATUSES = new Set(["starting", "running", "stopping"]);

function logPaths(job: BackgroundJob | undefined, kind: JobStream): readonly string[] {
  const chunks = job?.artifacts?.[kind]?.chunks;
  if (chunks?.length) return chunks;
  const base = kind === "stdout" ? job?.stdoutArtifact : job?.stderrArtifact;
  return base ? [base] : [];
}

export function createJobTailPagerSource(
  options: JobTailSourceOptions,
): ArtifactPagerSource | undefined {
  const { jobs, jobId } = options;
  const stream = options.stream ?? "stdout";
  const pageBytes = options.pageBytes ?? DEFAULT_ARTIFACT_PAGE_BYTES;

  const paths = (): readonly string[] => {
    const job = jobs.get(jobId);
    if (stream === "combined") return [...logPaths(job, "stdout"), ...logPaths(job, "stderr")];
    return logPaths(job, stream).slice(-1);
  };
  const initialPath = paths()[0];
  if (!initialPath) return undefined;

  const initialJob = jobs.get(jobId);
  const stdoutPath = initialJob?.stdoutArtifact;
  const prelude = options.hideCommandEcho && initialJob?.commandDisplay
    ? redactSecrets(jobStdoutPrelude(initialJob.commandDisplay))
    : undefined;
  const hiddenPrefix = prelude ? Buffer.from(prelude) : undefined;
  const isGrowing = (): boolean => isLiveJobStatus(jobs.get(jobId)?.status ?? "lost");
  const combinedFiles = (): JobLogFile[] => {
    const growing = isGrowing();
    return paths().map((path) => ({ path, hiddenPrefix: path === stdoutPath ? hiddenPrefix : undefined, waitForPrefix: growing }));
  };
  const combined = stream === "combined" ? createBytePagerSource(initialPath, pageBytes, createJobLogView(
    combinedFiles,
    () => jobs.outputPreview?.(jobId) ?? [],
  )) : undefined;

  let disposed = false;
  const subscriptions = new Set<() => void>();
  const delegates = new Map<string, ArtifactPagerSource>();
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("job tail source is disposed");
    if (combined) return combined;
    const path = paths()[0] ?? initialPath;
    const existing = delegates.get(path);
    if (existing) return existing;
    const prefix = stream === "stdout" && path === stdoutPath ? prelude : undefined;
    const created = createArtifactPagerSource(path, pageBytes, prefix);
    delegates.set(path, created);
    return created;
  };

  return {
    path: initialPath,
    pageBytes: combined?.pageBytes ?? pageBytes,
    commandTone: () => {
      const job = jobs.get(jobId);
      return pagerCommandTone(job?.status ?? "lost", job?.exitCode);
    },
    commandText: () => {
      const job = jobs.get(jobId);
      return job?.commandDisplay || job?.command;
    },
    readPage: (offset) => active().readPage(offset),
    readTail: () => {
      const source = active();
      return source.readTail
        ? source.readTail()
        : source.readPage(0);
    },
    search: (query, fromOffset, reverse) =>
      active().search(query, fromOffset, reverse),
    readAll: () => active().readAll(),
    isGrowing,
    watch(onChange) {
      if (disposed) return () => undefined;
      let watched = new Set<string>();
      const changed = (): void => { if (!disposed) onChange(); };
      const syncWatches = (): void => {
        const next = new Set(paths());
        for (const path of watched) if (!next.has(path)) unwatchFile(path, changed);
        for (const path of next) if (!watched.has(path)) watchFile(path, { persistent: false, interval: 200 }, changed);
        watched = next;
      };
      syncWatches();
      const unsubscribe = jobs.subscribe((change) => {
        if (change.jobId !== jobId) return;
        syncWatches();
        changed();
      });
      const cleanup = (): void => {
        unsubscribe();
        for (const path of watched) unwatchFile(path, changed);
        watched.clear();
        subscriptions.delete(cleanup);
      };
      subscriptions.add(cleanup);
      return cleanup;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of subscriptions) cleanup();
      subscriptions.clear();
      combined?.dispose();
      for (const delegate of delegates.values()) delegate.dispose();
      delegates.clear();
    },
  };
}

export function jobTailTitle(command: string, live: boolean): string {
  const label = live ? "live" : "output";
  const trimmed = command.replace(/\s+/g, " ").trim();
  const shown = trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
  return `${shown} · ${label}`;
}

export function isLiveJobStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

export type { ArtifactPage };
