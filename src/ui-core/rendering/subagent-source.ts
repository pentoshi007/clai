import type { SubagentManager } from "../../agent/subagents/manager.js";
import type { SubagentRun } from "../../agent/subagents/types.js";
import {
  createTextPagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";
import { SUBAGENT_TOOL_CONTINUATION_INDENT } from "./subagent-presentation.js";
import { subagentDurationLabel } from "./duration.js";

function assistantText(text: string): string {
  return text.replace(/```tool\b[^\n]*\n?[\s\S]*?(?:```|$)/gi, "").trim();
}

function indentContinuation(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n/g, `\n${SUBAGENT_TOOL_CONTINUATION_INDENT}`);
}

function describeToolCall(name: string, rawArgs: string): string {
  let args: unknown;
  try { args = JSON.parse(rawArgs); } catch { return `→ ${name} ${rawArgs}`; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return `→ ${name} ${rawArgs}`;
  const fields = Object.entries(args);
  const target = fields.find(([key]) => key === "path" || key === "url" || key === "command");
  const options = fields.filter(([key]) => key !== target?.[0]).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `→ ${name}${target ? ` ${String(target[1])}` : ""}${options.length ? ` (${options.join(", ")})` : ""}`;
}

function toolCall(text: string): string | undefined {
  const match = /^Calling ([\w.-]+):\s*([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  return indentContinuation(describeToolCall(match[1]!, match[2]!));
}

function activity(run: SubagentRun): string[] {
  const lines: string[] = [];
  let pendingTool: number | undefined;
  for (const event of run.events) {
    if (event.kind === "assistant") {
      const text = assistantText(event.text);
      const finalReport = run.report && (/^Status: (?:complete|partial)\b/i.test(text) || text.startsWith(run.report.trim()));
      if (text && !finalReport && text !== lines.at(-1)) lines.push(text);
    } else if (event.kind === "tool") {
      const call = toolCall(event.text);
      if (call) {
        lines.push(call);
        pendingTool = lines.length - 1;
      } else if (/^Success:/.test(event.text)) {
        if (pendingTool !== undefined) lines[pendingTool] = lines[pendingTool]!.replace(/^→/, "✓");
        else lines.push("✓ Read-only tool completed");
        pendingTool = undefined;
      } else if (/^Error:/.test(event.text)) {
        if (pendingTool !== undefined) lines[pendingTool] = lines[pendingTool]!.replace(/^→/, "✗");
        lines.push(`  ✗ ${event.text.replace(/^Error:\s*/, "")}`);
        pendingTool = undefined;
      } else {
        lines.push(event.text);
      }
    } else {
      if (run.error && event.text === `Subagent did not complete: ${run.error}`) continue;
      lines.push(`Notice: ${event.text}`);
    }
  }
  if (pendingTool !== undefined) lines.push(run.status === "running" ? "  In progress" : "  No result recorded");
  return lines;
}

export const isLiveSubagentRun = (run: SubagentRun): boolean => run.status === "running" || run.status === "stopping";

export function subagentsBarVisible(runs: readonly SubagentRun[]): boolean {
  return runs.some((run) => isLiveSubagentRun(run) || !run.resultAcknowledged);
}

export function orderSubagentRuns(runs: readonly SubagentRun[]): readonly SubagentRun[] {
  const live = runs.filter(isLiveSubagentRun);
  const settled = runs.filter((run) => !isLiveSubagentRun(run)).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...live, ...settled];
}

export function formatSubagentRun(run: SubagentRun, now = Date.now()): string {
  const events = activity(run);
  const duration = subagentDurationLabel(run, now);
  return [
    `# ${run.title}`,
    `${run.status} · attempt ${run.attempt} · ${run.activeProvider ?? run.provider}/${run.activeModel ?? run.model}`,
    ...(duration ? [`${duration[0]!.toUpperCase()}${duration.slice(1)}`] : []),
    `Workspace: ${run.cwd}`,
    `Agent: ${run.id}`,
    ...(run.recovery ? [`Recovery: ${run.recovery === "exact" ? "saved conversation checkpoint" : run.recovery === "history" ? "retained evidence; exact checkpoint unavailable" : "fresh investigation"}`] : []),
    "",
    "## Assignment",
    run.prompt,
    ...(run.context ? ["", "## Context", run.context] : []),
    "",
    "## Activity",
    ...(events.length ? events : [run.status === "running" ? "Waiting for the first update…" : "No activity recorded."]),
    ...(run.report ? ["", run.status === "partial" ? "## Partial report · investigation unfinished" : "## Report", run.report] : []),
    ...(run.error ? ["", run.status === "stopped" ? "## Stopped" : "## Error", run.error] : []),
  ].join("\n");
}

export function watchSubagents(
  manager: Pick<SubagentManager, "subscribe">,
  onChange: () => void,
  live?: () => boolean,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const syncClock = (): void => {
    if (live?.()) {
      if (clock !== undefined) return;
      clock = setInterval(() => {
        syncClock();
        if (clock !== undefined) onChange();
      }, 1000);
      clock.unref?.();
    } else if (clock !== undefined) {
      clearInterval(clock);
      clock = undefined;
    }
  };
  const unsubscribe = manager.subscribe(() => {
    syncClock();
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, 75);
    timer.unref?.();
  });
  syncClock();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (clock !== undefined) clearInterval(clock);
    timer = undefined;
    clock = undefined;
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
  let snapshot: SubagentRun | undefined;
  let duration: string | undefined;
  let delegate: ArtifactPagerSource | undefined;
  const watchers = new Set<() => void>();
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("subagent pager source is disposed");
    const run = manager.get(id);
    const now = Date.now();
    const nextDuration = run ? subagentDurationLabel(run, now) : undefined;
    if (delegate && run === snapshot && nextDuration === duration) return delegate;
    snapshot = run;
    duration = nextDuration;
    const next = run ? formatSubagentRun(run, now) : "This subagent is no longer available.";
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
      let observed = manager.get(id);
      let observedDuration = observed ? subagentDurationLabel(observed, Date.now()) : undefined;
      const stop = watchSubagents(manager, () => {
        const next = manager.get(id);
        const nextDuration = next ? subagentDurationLabel(next, Date.now()) : undefined;
        if (next === observed && nextDuration === observedDuration) return;
        observed = next;
        observedDuration = nextDuration;
        onChange();
      }, () => {
        const run = manager.get(id);
        return run !== undefined && isLiveSubagentRun(run);
      });
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
      snapshot = undefined;
      duration = undefined;
    },
  };
}
