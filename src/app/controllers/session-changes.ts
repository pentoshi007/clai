import type { FileChange } from "../../tools/file-diff.js";
import type { TranscriptItem } from "../ports/transcript-item.js";

export interface LineChangeTotals {
  readonly added: number;
  readonly removed: number;
}

export interface FileLineChanges extends LineChangeTotals {
  readonly path: string;
}

export interface SessionChangesReport {
  readonly totals: LineChangeTotals | undefined;
  readonly files: readonly FileLineChanges[];
  readonly changes: readonly FileChange[];
}

export function validLineChangeTotals(value: unknown): value is LineChangeTotals {
  if (!value || typeof value !== "object") return false;
  const { added, removed } = value as LineChangeTotals;
  return Number.isSafeInteger(added) && added >= 0 && Number.isSafeInteger(removed) && removed >= 0;
}

export function sumLineChanges(values: Iterable<LineChangeTotals>): LineChangeTotals | undefined {
  let added = 0;
  let removed = 0;
  for (const value of values) {
    if (!validLineChangeTotals(value)) continue;
    added += value.added;
    removed += value.removed;
  }
  return added || removed ? { added, removed } : undefined;
}

function countedFileChanges(changes: readonly FileChange[] | undefined): FileChange[] {
  return (Array.isArray(changes) ? changes : []).filter((change) =>
    change && typeof change.path === "string" && change.path && !change.binary && validLineChangeTotals(change.stats) &&
    (change.stats.added > 0 || change.stats.removed > 0));
}

export function fileLineChanges(changes: readonly FileChange[] | undefined): FileLineChanges[] {
  return countedFileChanges(changes).map((change) => ({ path: change.path, added: change.stats.added, removed: change.stats.removed }));
}

function settledToolItems(transcript: readonly TranscriptItem[]): Extract<TranscriptItem, { kind: "tool" }>[] {
  const out: Extract<TranscriptItem, { kind: "tool" }>[] = [];
  const visit = (items: readonly TranscriptItem[]): void => {
    for (const item of items) {
      if (item.kind === "compacted" && Array.isArray(item.originalItems)) visit(item.originalItems);
      else if (item.kind === "tool" && item.status !== "running" && item.status !== "blocked") out.push(item);
    }
  };
  visit(transcript);
  return out;
}

export class SessionChanges {
  private readonly files = new Map<string, FileLineChanges>();
  private readonly recorded = new Set<string>();
  private readonly diffIds = new Set<string>();
  private diffs: FileChange[] = [];
  private report: SessionChangesReport | undefined;

  record(toolCallId: string, changes: readonly FileChange[] | undefined): void {
    this.recordDiffs(toolCallId, changes);
    if (this.recorded.has(toolCallId)) return;
    const files = fileLineChanges(changes);
    if (!files.length) return;
    this.recorded.add(toolCallId);
    for (const file of files) this.add(file);
  }

  restore(saved?: readonly FileLineChanges[], transcript: readonly TranscriptItem[] = []): void {
    this.files.clear();
    this.recorded.clear();
    this.diffIds.clear();
    this.diffs = [];
    this.report = undefined;
    const tools = settledToolItems(transcript);
    if (!Array.isArray(saved)) {
      for (const item of tools) this.record(item.id, item.fileChanges);
      return;
    }
    for (const item of tools) this.recordDiffs(item.id, item.fileChanges);
    for (const file of saved) {
      const path = file?.path;
      if (typeof path === "string" && path && validLineChangeTotals(file)) {
        this.add({ path, added: file.added, removed: file.removed });
      }
    }
  }

  snapshot(): SessionChangesReport {
    if (this.report) return this.report;
    const files = [...this.files.values()].map((file) => ({ ...file })).sort((a, b) => a.path.localeCompare(b.path));
    this.report = { files, totals: sumLineChanges(files), changes: [...this.diffs] };
    return this.report;
  }

  private recordDiffs(id: string, changes: readonly FileChange[] | undefined): void {
    if (this.diffIds.has(id)) return;
    const recorded = countedFileChanges(changes);
    if (!recorded.length) return;
    this.diffIds.add(id);
    this.diffs.push(...recorded);
    this.report = undefined;
  }

  private add(file: FileLineChanges): void {
    if (file.added === 0 && file.removed === 0) return;
    this.report = undefined;
    const previous = this.files.get(file.path);
    this.files.set(file.path, {
      path: file.path,
      added: (previous?.added ?? 0) + file.added,
      removed: (previous?.removed ?? 0) + file.removed,
    });
  }
}
