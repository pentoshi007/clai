import type { JobsPort } from "../../app/ports/jobs-port.js";
import {
  createArtifactPagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPage,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

export interface JobTailSourceOptions {
  readonly jobs: JobsPort;
  readonly jobId: string;
  readonly stream?: "stdout" | "stderr";
  readonly pageBytes?: number;
}

const LIVE_STATUSES = new Set(["starting", "running", "stopping"]);

/**
 * Live view over a background job's output.
 *
 * Bytes are never buffered: every read is one stat plus one bounded page read
 * straight off the artifact file, and the path is re-resolved each time so a
 * rotation to `<artifact>.N` is followed without restarting the view. Updates
 * are driven by the job manager's existing change stream, which is already
 * coalesced to a few notifications per second, so following adds no timer.
 */
export function createJobTailPagerSource(
  options: JobTailSourceOptions,
): ArtifactPagerSource | undefined {
  const { jobs, jobId } = options;
  const stream = options.stream ?? "stdout";
  const pageBytes = options.pageBytes ?? DEFAULT_ARTIFACT_PAGE_BYTES;

  const currentPath = (): string | undefined => {
    const job = jobs.get(jobId);
    if (!job) return undefined;
    const receipt = stream === "stderr" ? job.artifacts?.stderr : job.artifacts?.stdout;
    const rotated = receipt?.chunks?.at(-1);
    return rotated ?? (stream === "stderr" ? job.stderrArtifact : job.stdoutArtifact);
  };

  const initialPath = currentPath();
  if (!initialPath) return undefined;

  let disposed = false;
  const delegates = new Map<string, ArtifactPagerSource>();
  const delegateFor = (path: string): ArtifactPagerSource => {
    const existing = delegates.get(path);
    if (existing) return existing;
    const created = createArtifactPagerSource(path, pageBytes);
    delegates.set(path, created);
    return created;
  };

  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("job tail source is disposed");
    return delegateFor(currentPath() ?? initialPath);
  };

  const isGrowing = (): boolean => {
    const job = jobs.get(jobId);
    return job ? LIVE_STATUSES.has(job.status) : false;
  };

  return {
    path: initialPath,
    pageBytes,
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
      return jobs.subscribe((change) => {
        if (change.jobId !== jobId) return;
        onChange();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
