import type { SubagentManager } from "../../agent/subagents/manager.js";
import type { SubagentRun } from "../../agent/subagents/types.js";
import {
  createTextPagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

export function formatSubagentRun(run: SubagentRun): string {
  return [
    `${run.title} · ${run.id} · ${run.status} · attempt ${run.attempt}`,
    `${run.provider}/${run.model} · ${run.cwd}`,
    "",
    "Assignment",
    run.prompt,
    ...(run.context ? ["", "Context", run.context] : []),
    "",
    ...run.events.map((event) => `[${event.kind}] ${event.text}`),
    ...(run.report ? ["", "Report", run.report] : []),
    ...(run.error ? ["", "Error", run.error] : []),
  ].join("\n");
}

export function watchSubagents(
  manager: Pick<SubagentManager, "subscribe">,
  onChange: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = manager.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, 75);
    timer.unref?.();
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

export function createSubagentPagerSource(
  manager: Pick<SubagentManager, "get" | "subscribe">,
  id: string,
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
): ArtifactPagerSource {
  const path = `memory://subagent/${id}`;
  let disposed = false;
  let text: string | undefined;
  let delegate: ArtifactPagerSource | undefined;
  const watchers = new Set<() => void>();
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("subagent pager source is disposed");
    const run = manager.get(id);
    const next = run ? formatSubagentRun(run) : "This subagent is no longer available.";
    if (!delegate || next !== text) {
      delegate?.dispose();
      text = next;
      delegate = createTextPagerSource(next, path, pageBytes);
    }
    return delegate;
  };
  return {
    path,
    pageBytes: active().pageBytes,
    readPage: (offset) => active().readPage(offset),
    readTail: () => active().readTail!(),
    readAll: () => active().readAll(),
    search: (query, offset, reverse) => active().search(query, offset, reverse),
    isGrowing() {
      if (disposed) return false;
      const status = manager.get(id)?.status;
      return status === "running" || status === "stopping";
    },
    watch(onChange) {
      if (disposed) return () => undefined;
      const stop = watchSubagents(manager, onChange);
      const cleanup = (): void => {
        stop();
        watchers.delete(cleanup);
      };
      watchers.add(cleanup);
      return cleanup;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of watchers) cleanup();
      delegate?.dispose();
      delegate = undefined;
      text = undefined;
    },
  };
}
