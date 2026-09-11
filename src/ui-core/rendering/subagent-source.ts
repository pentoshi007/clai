import type { SubagentManager } from "../../agent/subagents/manager.js";
import type { SubagentRun } from "../../agent/subagents/types.js";
import {
  createTextPagerSource,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";

function assistantText(text: string): string {
  return text.replace(/```tool\b[^\n]*\n?[\s\S]*?(?:```|$)/gi, "").trim();
}

function toolCall(text: string): string | undefined {
  const match = /^Calling ([\w.-]+):\s*([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  let args: unknown;
  try { args = JSON.parse(match[2]!); } catch { return `→ ${match[1]} ${match[2]}`; }
  if (!args || typeof args !== "object" || Array.isArray(args)) return `→ ${match[1]} ${match[2]}`;
  const fields = Object.entries(args);
  const target = fields.find(([key]) => key === "path" || key === "url" || key === "command");
  const options = fields.filter(([key]) => key !== target?.[0]).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `→ ${match[1]}${target ? ` ${String(target[1])}` : ""}${options.length ? ` (${options.join(", ")})` : ""}`;
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

export function formatSubagentRun(run: SubagentRun): string {
  const events = activity(run);
  return [
    `# ${run.title}`,
    `${run.status} · attempt ${run.attempt} · ${run.provider}/${run.model}`,
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
  let snapshot: SubagentRun | undefined;
  let delegate: ArtifactPagerSource | undefined;
  const watchers = new Set<() => void>();
  const active = (): ArtifactPagerSource => {
    if (disposed) throw new Error("subagent pager source is disposed");
    const run = manager.get(id);
    if (delegate && run === snapshot) return delegate;
    snapshot = run;
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
      let observed = manager.get(id);
      const stop = watchSubagents(manager, () => {
        const next = manager.get(id);
        if (next === observed) return;
        observed = next;
        onChange();
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
    },
  };
}
