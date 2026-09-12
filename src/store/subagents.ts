import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentEvent, SubagentRun, SubagentStore } from "../agent/subagents/types.js";
import { redactSecrets } from "../llm/provider.js";
import { sanitizeDisplayText } from "../ui-core/rendering/sanitize-display.js";
import { getHistoryDir } from "./paths.js";

export const SUBAGENT_LIMITS = Object.freeze({ records: 24, events: 96, chars: 128_000, report: 4 * 1024 * 1024, title: 120, prompt: 12_000, context: 24_000 });
const MAX_FILE_BYTES = 6 * (2 * SUBAGENT_LIMITS.report + SUBAGENT_LIMITS.chars) + 65_536;
const FILE_NAME = /^[a-f0-9]{64}\.json$/;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function sanitizeSubagentText(value: string): string {
  return redactSecrets(sanitizeDisplayText(value))
    .replace(/\b(?:wk-|ws-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/(\b(?:bearer|authorization["']?\s*[:=]\s*["']?basic)\s+)[^\s,;"'}]+/gi, "$1[redacted]")
    .replace(/(\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[=:]\s*)(?!\[redacted\])(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]");
}

export function isValidSubagentParentId(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 256) return false;
  // Generated session IDs can contain sk- across the timestamp/entropy boundary.
  return /^sess-[a-z0-9]{8,11}-[a-z0-9]{0,6}$/.test(value) || sanitizeSubagentText(value) === value;
}

export function sanitizeSubagentRun(run: SubagentRun): SubagentRun {
  const clean = (value: string, maximum: number): string => sanitizeSubagentText(value).slice(0, maximum);
  const report = run.report === undefined ? undefined : sanitizeSubagentText(run.report);
  if (report !== undefined && Buffer.byteLength(report) > SUBAGENT_LIMITS.report) throw new Error("Subagent report exceeds the storage safety limit");
  const previousSummary = run.lastKnownSummary ?? (report && (run.status === "completed" || run.status === "partial")
    ? { attempt: run.attempt, status: run.status, report } : undefined);
  const lastKnownSummary = previousSummary && Object.freeze({
    attempt: previousSummary.attempt, status: previousSummary.status, report: sanitizeSubagentText(previousSummary.report),
  });
  if (lastKnownSummary && Buffer.byteLength(lastKnownSummary.report) > SUBAGENT_LIMITS.report) throw new Error("Subagent summary exceeds the storage safety limit");
  const base = {
    id: run.id, parentSessionId: run.parentSessionId, attempt: run.attempt,
    status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
    recovery: run.recovery,
    title: clean(run.title, SUBAGENT_LIMITS.title),
    prompt: clean(run.prompt, SUBAGENT_LIMITS.prompt),
    context: run.context === undefined ? undefined : clean(run.context, SUBAGENT_LIMITS.context),
    followup: run.followup === undefined ? undefined : Object.freeze({
      prompt: run.followup.prompt === undefined ? undefined : clean(run.followup.prompt, SUBAGENT_LIMITS.prompt),
      context: run.followup.context === undefined ? undefined : clean(run.followup.context, SUBAGENT_LIMITS.context),
    }),
    cwd: clean(run.cwd, 4096),
    provider: clean(run.provider, 128) as SubagentRun["provider"],
    model: clean(run.model, 256),
    report,
    lastKnownSummary,
    resultAcknowledged: run.resultAcknowledged,
    error: run.error === undefined ? undefined : clean(run.error, 4096),
  };
  let remaining = SUBAGENT_LIMITS.chars - [base.title, base.prompt, base.context, base.followup?.prompt, base.followup?.context, base.cwd, base.provider, base.model, base.error, base.id, base.parentSessionId].reduce<number>((sum, value) => sum + (value?.length ?? 0), 0);
  const events: SubagentEvent[] = [];
  for (const event of run.events.slice(-SUBAGENT_LIMITS.events).reverse()) {
    if (remaining <= 0) break;
    const text = clean(event.text, remaining);
    remaining -= text.length;
    events.unshift(Object.freeze({ sequence: event.sequence, kind: event.kind, timestamp: event.timestamp, text }));
  }
  return Object.freeze({ ...base, events: Object.freeze(events) });
}

function validRun(value: unknown, parentSessionId: string): value is SubagentRun {
  if (!value || typeof value !== "object") return false;
  const run = value as SubagentRun;
  const bounded = (text: unknown, maximum: number): text is string => typeof text === "string" && text.length <= maximum;
  const followup = run.followup;
  const summary = run.lastKnownSummary;
  if (summary !== undefined && (!summary || typeof summary !== "object" || Array.isArray(summary)
    || !Number.isSafeInteger(summary.attempt) || summary.attempt < 1 || summary.attempt > run.attempt
    || !["completed", "partial"].includes(summary.status)
    || !bounded(summary.report, SUBAGENT_LIMITS.report) || !summary.report.trim()
    || Buffer.byteLength(summary.report) > SUBAGENT_LIMITS.report)) return false;
  if (followup !== undefined && (!followup || typeof followup !== "object" || Array.isArray(followup)
    || (followup.prompt === undefined && followup.context === undefined)
    || !(["prompt", "context"] as const).every((name) => followup[name] === undefined
      || (bounded(followup[name], SUBAGENT_LIMITS[name]) && !!sanitizeSubagentText(followup[name]).trim())))) return false;
  return isValidSubagentParentId(parentSessionId)
    && run.parentSessionId === parentSessionId && typeof run.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(run.id) && sanitizeSubagentText(run.id) === run.id
    && Number.isSafeInteger(run.attempt) && run.attempt > 0
    && Number.isFinite(run.createdAt) && Number.isFinite(run.updatedAt)
    && ["running", "stopping", "completed", "partial", "stopped", "error"].includes(run.status)
    && (run.recovery === undefined || ["exact", "history", "fresh"].includes(run.recovery))
    && bounded(run.title, SUBAGENT_LIMITS.title) && !!run.title.trim() && bounded(run.prompt, SUBAGENT_LIMITS.prompt) && !!run.prompt.trim()
    && (run.context === undefined || bounded(run.context, SUBAGENT_LIMITS.context))
    && bounded(run.cwd, 4096) && !!run.cwd.trim() && bounded(run.provider, 128) && !!run.provider.trim() && bounded(run.model, 256) && !!run.model.trim()
    && (run.report === undefined || (bounded(run.report, SUBAGENT_LIMITS.report) && Buffer.byteLength(run.report) <= SUBAGENT_LIMITS.report))
    && (run.error === undefined || bounded(run.error, 4096))
    && (run.resultAcknowledged === undefined || typeof run.resultAcknowledged === "boolean")
    && Array.isArray(run.events) && run.events.length <= SUBAGENT_LIMITS.events
    && run.events.every((event) => event && ["assistant", "tool", "notice"].includes(event.kind)
      && Number.isSafeInteger(event.sequence) && event.sequence >= 0 && Number.isFinite(event.timestamp)
      && bounded(event.text, SUBAGENT_LIMITS.chars));
}

export function restoreSubagentRun(value: unknown, parentSessionId: string): SubagentRun | undefined {
  if (!validRun(value, parentSessionId)) return undefined;
  const run: SubagentRun = {
    id: value.id, parentSessionId, title: value.title, prompt: value.prompt, context: value.context, followup: value.followup,
    cwd: value.cwd, provider: value.provider, model: value.model, attempt: value.attempt,
    status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt,
    events: value.events.map(({ sequence, kind, text, timestamp }) => ({ sequence, kind, text, timestamp })),
    report: value.report, error: value.error, lastKnownSummary: value.lastKnownSummary,
    resultAcknowledged: value.resultAcknowledged,
    recovery: value.events.length || value.report || value.lastKnownSummary ? "history" : "fresh",
  };
  if (run.status !== "running" && run.status !== "stopping") return sanitizeSubagentRun(run);
  return sanitizeSubagentRun({
    ...run, status: "stopped", report: undefined, resultAcknowledged: false, error: "Interrupted before completion; restart explicitly.",
    events: [...run.events, { sequence: Math.max(0, ...run.events.map((event) => event.sequence)) + 1, kind: "notice", text: "Interrupted before completion; restart explicitly.", timestamp: Date.now() }],
  });
}

export class FileSubagentStore implements SubagentStore {
  private readonly root: string;

  constructor(historyDir = getHistoryDir()) {
    this.root = join(historyDir, "subagents");
  }

  private directory(parentSessionId: string, create = false): string | undefined {
    if (!parentSessionId || parentSessionId.length > 256) throw new Error("Invalid parent session ID");
    const directory = join(this.root, hash(parentSessionId));
    for (const path of [this.root, directory]) {
      if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe subagent history directory");
        if (create) chmodSync(path, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }
    return directory;
  }

  private files(directory: string): string[] {
    const result: string[] = [];
    const handle = opendirSync(directory);
    try {
      while (true) {
        const entry = handle.readSync();
        if (!entry) break;
        if (entry.isFile() && FILE_NAME.test(entry.name)) result.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    return result;
  }

  private read(directory: string, name: string, parentSessionId: string): SubagentRun | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > stat.size) return undefined;
      const data: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (validRun(data, parentSessionId) && name === `${hash(data.id)}.json`) return data;
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return undefined;
  }

  load(parentSessionId: string): readonly SubagentRun[] {
    const directory = this.directory(parentSessionId);
    if (!directory) return [];
    const runs: SubagentRun[] = [];
    for (const name of this.files(directory)) {
      const run = this.read(directory, name, parentSessionId);
      if (run) runs.push(run);
    }
    let settled = 0;
    return runs.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .filter((run) => run.status === "running" || run.status === "stopping" || !run.resultAcknowledged || settled++ < SUBAGENT_LIMITS.records)
      .flatMap((run) => restoreSubagentRun(run, parentSessionId) ?? []);
  }

  save(run: SubagentRun): void {
    if (!validRun(run, run.parentSessionId)) throw new Error("Invalid subagent record");
    const directory = this.directory(run.parentSessionId, true)!;
    const target = join(directory, `${hash(run.id)}.json`);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(sanitizeSubagentRun(run)), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    if (run.status === "running" || run.status === "stopping") return;
    const names = this.files(directory);
    if (names.length <= SUBAGENT_LIMITS.records) return;
    const files = names.map((name) => {
      const record = this.read(directory, name, run.parentSessionId);
      return { name, active: !!record && (record.status === "running" || record.status === "stopping" || !record.resultAcknowledged), updatedAt: record?.updatedAt ?? -Infinity, createdAt: record?.createdAt ?? -Infinity, id: record?.id ?? "" };
    });
    files.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.name === `${hash(run.id)}.json`) - Number(a.name === `${hash(run.id)}.json`) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    for (const file of files.filter((file) => !file.active).slice(SUBAGENT_LIMITS.records)) rmSync(join(directory, file.name), { force: true });
  }

  remove(parentSessionId: string): void {
    const directory = this.directory(parentSessionId);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

export function createSubagentStore(historyDir?: string): SubagentStore {
  return new FileSubagentStore(historyDir);
}
