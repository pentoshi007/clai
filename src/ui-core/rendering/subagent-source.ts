import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseSubagentActivityHeader, unescapeSubagentActivityLine } from "../../agent/subagents/activity-framing.js";
import type { SubagentManager } from "../../agent/subagents/manager.js";
import type { SubagentEvent, SubagentRun } from "../../agent/subagents/types.js";
import {
  DEFAULT_ARTIFACT_PAGE_BYTES,
  type ArtifactPage,
  type ArtifactPagerSource,
} from "./artifact-pager-source.js";
import { SUBAGENT_TOOL_CONTINUATION_INDENT } from "./subagent-presentation.js";
import { subagentDurationLabel } from "./duration.js";
import { formatToolArgs } from "../../agent/parser/arg-formatting.js";
import { presentFsReadArgs } from "./tool-presenter.js";
import { formatFsReadSection, parseFsReadSections } from "../../tools/fs/read-sections.js";

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
  if (name === "fs.read" && Array.isArray((args as Record<string, unknown>).files)) {
    const read = presentFsReadArgs(formatToolArgs({ name, args: args as Record<string, unknown> }));
    const files = read.files ?? [read];
    return [`→ ${name}`, ...files.flatMap((file, index) => [
      ...(file.options ? [`options: ${file.options}`] : []),
      `${read.files ? `file ${index + 1}/${files.length}` : "file"}: ${file.path}`,
    ])].join("\n");
  }
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

function activity(run: SubagentRun, events = run.events): string[] {
  const lines: string[] = [];
  let pendingTool: number | undefined;
  for (const event of events) {
    if (event.kind === "assistant") {
      const text = assistantText(event.text);
      const report = run.report?.trim();
      const reportBody = report?.replace(/^Status: (?:complete|partial)\b[^\n]*\n?/i, "").trim();
      const assistantBody = text.replace(/^Status: (?:complete|partial)\b[^\n]*\n?/i, "").trim();
      const finalReport = report && (text.startsWith(report) || reportBody && assistantBody.startsWith(reportBody));
      if (text && !finalReport && text !== lines.at(-1)) lines.push(text);
    } else if (event.kind === "tool") {
      const call = toolCall(event.text);
      const reads = parseFsReadSections(event.text.replace(/^Success:\s*/, ""));
      if (call) {
        lines.push(call);
        pendingTool = lines.length - 1;
      } else if (reads.length > 0) {
        if (pendingTool !== undefined) {
          let display = lines[pendingTool]!.replace(/^→/, reads.every((read) => read.ok) ? "✓" : "✗");
          for (const read of reads) {
            display = display.replace(new RegExp(`(^\\s*file ${read.index}/${read.total}: )`, "m"), `$1${read.ok ? "✓" : "✗"} `);
          }
          lines[pendingTool] = display;
        } else {
          lines.push(...reads.map((read) => `  ${read.ok ? "✓" : "✗"} file ${read.index}/${read.total}: ${read.path}`));
        }
        for (const read of reads.filter((entry) => !entry.ok)) {
          lines.push(`  ✗ ${read.path}: ${read.body.split("\n")[0]?.slice(0, 240) ?? "read failed"}`);
        }
        pendingTool = undefined;
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
      const settlement = /^(completed|partial|stopped|error) · attempt (\d+)(?:\n|$)/.exec(event.text);
      if (pendingTool !== undefined && (settlement || /^(?:Attempt \d+:|Parent follow-up for attempt \d+:)/.test(event.text))) {
        lines.push("  No result recorded");
        pendingTool = undefined;
      }
      if (settlement?.[1] === run.status && Number(settlement[2]) === run.attempt) continue;
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
  return formatSubagentTranscript(run, activity(run), now);
}

function formatSubagentTranscript(run: SubagentRun, events: readonly string[], now: number): string {
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

function compactActivityEvent(event: SubagentEvent): SubagentEvent {
  if (event.kind !== "tool" || !/^Success:/.test(event.text)) return event;
  const reads = parseFsReadSections(event.text.replace(/^Success:\s*/, ""));
  return {
    ...event,
    text: ["Success:", ...reads.map((read) => formatFsReadSection({
      ...read,
      body: read.ok ? "" : read.body.split("\n")[0] ?? "read failed",
    }))].join("\n"),
  };
}

class SubagentActivityHistory {
  private path: string | undefined;
  private identity: string | undefined;
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private remainder = "";
  private record: { sequence: number; kind: SubagentEvent["kind"]; escaped: boolean; lines: string[] } | undefined;
  private current: SubagentEvent | undefined;
  private previousBlank = true;
  private attempt = 0;
  private sequence = -1;
  private readonly liveEvents = new Map<number, SubagentEvent>();
  private readonly events = new Map<number, SubagentEvent>();
  private revision = 0;

  get version(): number { return this.revision; }

  private reset(path?: string): void {
    this.path = path;
    this.identity = undefined;
    this.offset = 0;
    this.decoder = new StringDecoder("utf8");
    this.remainder = "";
    this.record = undefined;
    this.current = undefined;
    this.previousBlank = true;
    this.attempt = 0;
    this.sequence = -1;
    this.events.clear();
    this.revision += 1;
  }

  private snapshotRecord(): SubagentEvent | undefined {
    if (!this.record) return undefined;
    return compactActivityEvent({
      sequence: this.record.sequence,
      kind: this.record.kind,
      text: this.record.lines.join("\n").trimEnd(),
      timestamp: 0,
    });
  }

  private accept(line: string): void {
    const header = parseSubagentActivityHeader(line);
    const attempt = header?.attempt ?? 0;
    const sequence = header?.sequence ?? 0;
    const knownAssistant = header?.kind === "assistant" &&
      (this.events.get(sequence)?.kind === "assistant" || this.record?.sequence === sequence && this.record.kind === "assistant");
    const boundary = header && this.previousBlank && Number.isSafeInteger(attempt) && attempt > 0 && attempt >= this.attempt &&
      Number.isSafeInteger(sequence) && sequence >= 0 && (sequence > this.sequence || knownAssistant);
    if (boundary) {
      const previous = this.snapshotRecord();
      if (previous) this.events.set(previous.sequence, previous);
      this.record = { sequence, kind: header.kind, escaped: header.escaped, lines: [] };
      this.attempt = attempt;
      this.sequence = Math.max(this.sequence, sequence);
    } else if (this.record) {
      this.record.lines.push(this.record.escaped ? unescapeSubagentActivityLine(line) : line);
    }
    this.previousBlank = line === "";
  }

  async read(path: string | undefined): Promise<void> {
    if (!path) return;
    if (path !== this.path) this.reset(path);
    let handle;
    const previousOffset = this.offset;
    const previousRevision = this.revision;
    try { handle = await open(path, "r"); } catch { return; }
    try {
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      if (!info.isFile()) return;
      if ((this.identity !== undefined && this.identity !== identity) || info.size < this.offset) this.reset(path);
      this.identity = identity;
      if (info.size === this.offset) return;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (this.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - this.offset), this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const chunk = this.remainder + this.decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        let end = chunk.indexOf("\n");
        while (end >= 0) {
          this.accept(chunk.slice(start, end).replace(/\r$/, ""));
          start = end + 1;
          end = chunk.indexOf("\n", start);
        }
        this.remainder = chunk.slice(start);
      }
    } catch {
    } finally {
      if (this.offset !== previousOffset || this.revision !== previousRevision) {
        this.current = this.snapshotRecord();
        this.revision += 1;
      }
      await handle.close();
    }
  }

  merge(live: readonly SubagentEvent[]): readonly SubagentEvent[] {
    for (const event of live) {
      const compact = compactActivityEvent(event);
      const previous = this.liveEvents.get(event.sequence);
      if (!previous || compact.text.length >= previous.text.length) this.liveEvents.set(event.sequence, compact);
    }
    const merged = new Map(this.events);
    if (this.current) merged.set(this.current.sequence, this.current);
    for (const event of this.liveEvents.values()) {
      const persisted = merged.get(event.sequence);
      if (persisted && persisted.text.startsWith(event.text)) this.liveEvents.delete(event.sequence);
      else if (!persisted || event.text.length >= persisted.text.length) merged.set(event.sequence, event);
    }
    return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
  }

  dispose(): void {
    this.reset();
    this.liveEvents.clear();
  }
}

export function createSubagentPagerSource(
  manager: Pick<SubagentManager, "get" | "subscribe"> & Partial<Pick<SubagentManager, "activityPath">>,
  id: string,
  pageBytes = DEFAULT_ARTIFACT_PAGE_BYTES,
): ArtifactPagerSource {
  const path = `memory://subagent/${id}`;
  const history = new SubagentActivityHistory();
  let disposed = false;
  let text = "";
  let data = Buffer.alloc(0);
  let snapshot: SubagentRun | undefined;
  let duration: string | undefined;
  let historyVersion = -1;
  let events: readonly string[] = [];
  let reading: Promise<void> | undefined;
  const watchers = new Set<() => void>();
  const assertOpen = (): void => {
    if (disposed) throw new Error("subagent pager source is disposed");
  };
  const active = async (): Promise<void> => {
    assertOpen();
    if (!reading) {
      reading = history.read(manager.activityPath?.(id)).finally(() => { reading = undefined; });
    }
    await reading;
    if (disposed) history.dispose();
    assertOpen();
    const run = manager.get(id);
    const now = Date.now();
    const nextDuration = run ? subagentDurationLabel(run, now) : undefined;
    if (run === snapshot && history.version === historyVersion && nextDuration === duration) return;
    if (run !== snapshot || history.version !== historyVersion) {
      events = run ? activity(run, history.merge(run.events)) : [];
    }
    snapshot = run;
    duration = nextDuration;
    historyVersion = history.version;
    text = run ? formatSubagentTranscript(run, events, now) : "This subagent is no longer available.";
    data = Buffer.from(text, "utf8");
  };
  const page = (): ArtifactPage => ({
    body: text,
    offset: 0,
    nextOffset: data.length,
    totalBytes: data.length,
    pageNumber: 1,
    pageCount: 1,
  });
  const readPage = async (): Promise<ArtifactPage> => {
    await active();
    return page();
  };
  return {
    path,
    pageBytes,
    layout: "continuous",
    readPage,
    readTail: readPage,
    async readAll() {
      await active();
      return text;
    },
    async search(query, offset = 0, reverse = false) {
      await active();
      const needle = Buffer.from(query, "utf8");
      const from = reverse && offset === 0 ? data.length : Math.max(0, Math.min(offset, data.length));
      const index = reverse ? data.lastIndexOf(needle, Math.max(0, from - 1)) : data.indexOf(needle, from);
      return index < 0 ? undefined : page();
    },
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
      history.dispose();
      text = "";
      data = Buffer.alloc(0);
      snapshot = undefined;
      duration = undefined;
      events = [];
    },
  };
}
