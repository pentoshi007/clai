import type { PersistedSessionMerge } from "../ports/persistence-port.js";
import type { TranscriptItem } from "../ports/transcript-item.js";
import type { SessionPersistenceQueue } from "./session-persistence.js";

export const LATE_WORK_MARKER = "[session-sync]";

const NOTE_BUDGET_CHARS = 6_000;
const TEXT_CHARS = 1_200;
const ARGS_CHARS = 240;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function toolLine(item: Extract<TranscriptItem, { kind: "tool" }>): string {
  const counts = (item.fileChanges ?? [])
    .filter((change) => !change.binary && (change.stats.added > 0 || change.stats.removed > 0))
    .map((change) => `${change.path} +${change.stats.added} -${change.stats.removed}`);
  const parts = [`tool ${item.name} ${clip(item.argsDisplay, ARGS_CHARS)}`.trimEnd(), item.status];
  if (item.summary) parts.push(clip(item.summary, ARGS_CHARS));
  if (counts.length) parts.push(counts.join(", "));
  return `- ${parts.join(" · ")}`;
}

function entryLine(item: TranscriptItem): string | undefined {
  switch (item.kind) {
    case "user":
      return item.text.trim() ? `- user: ${clip(item.text, TEXT_CHARS)}` : undefined;
    case "assistant":
      return item.text.trim() ? `- assistant: ${clip(item.text, TEXT_CHARS)}` : undefined;
    case "tool":
      return toolLine(item);
    case "compacted":
      return item.summary.trim() ? `- compacted memory: ${clip(item.summary, TEXT_CHARS)}` : undefined;
    case "plan":
      return `- plan ${item.plan.status}: ${clip(item.plan.goal, ARGS_CHARS)}`;
    default:
      return undefined;
  }
}

export function lateWorkNote(items: readonly TranscriptItem[]): string | undefined {
  const lines = items.map(entryLine).filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (kept.length > 0 && used + line.length + 1 > NOTE_BUDGET_CHARS) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return [
    `${LATE_WORK_MARKER} Another clai process wrote the entries below to this session after this process loaded it, and they are now part of this conversation's transcript. Treat them as work that already happened: their file edits and commands are real, so check the current state before repeating or undoing anything.`,
    ...(omitted > 0 ? [`- … ${omitted} earlier entr${omitted === 1 ? "y" : "ies"} omitted`] : []),
    ...kept,
  ].join("\n");
}

export interface SessionLateWorkDeps {
  readonly persistence: Pick<SessionPersistenceQueue, "detectsMerges" | "pendingMerge">;
  readonly sessionId: () => string;
  readonly ready: () => boolean;
  readonly absorb: ((incoming: readonly TranscriptItem[]) => readonly TranscriptItem[]) | undefined;
  readonly absorbed: () => void;
  readonly pollMs?: number | undefined;
}

export class SessionLateWork {
  private items: TranscriptItem[] = [];
  private polling = false;
  private readonly timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SessionLateWorkDeps) {
    if (deps.absorb && deps.persistence.detectsMerges) {
      this.timer = setInterval(() => void this.poll(), deps.pollMs ?? 2_000);
      this.timer.unref?.();
    }
  }

  get unsyncedIds(): readonly string[] {
    return this.items.map((item) => item.id);
  }

  restore(ids: readonly string[] | undefined, transcript: readonly TranscriptItem[] | undefined): void {
    const wanted = new Set(ids ?? []);
    this.items = wanted.size && transcript ? transcript.filter((item) => wanted.has(item.id)) : [];
  }

  clear(): void {
    this.items = [];
  }

  accept(merge: PersistedSessionMerge | void): boolean {
    if (!merge || !this.deps.absorb || !this.deps.ready()) return false;
    const added = this.deps.absorb(merge.transcript);
    if (added.length === 0) return false;
    const known = new Set(this.items.map((item) => item.id));
    this.items.push(...added.filter((item) => !known.has(item.id)));
    this.deps.absorbed();
    return true;
  }

  takeNote(): string | undefined {
    const note = lateWorkNote(this.items);
    this.items = [];
    return note;
  }

  async poll(): Promise<boolean> {
    if (this.polling || !this.deps.ready()) return false;
    this.polling = true;
    try {
      const sessionId = this.deps.sessionId();
      const merge = await this.deps.persistence.pendingMerge(sessionId).catch(() => undefined);
      return sessionId === this.deps.sessionId() && this.accept(merge);
    } finally {
      this.polling = false;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.items = [];
  }
}
