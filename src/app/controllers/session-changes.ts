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

export function fileLineChanges(changes: readonly FileChange[] | undefined): FileLineChanges[] {
  return (Array.isArray(changes) ? changes : []).flatMap((change) =>
    change && typeof change.path === "string" && change.path && !change.binary && validLineChangeTotals(change.stats) &&
      (change.stats.added > 0 || change.stats.removed > 0)
      ? [{ path: change.path, added: change.stats.added, removed: change.stats.removed }]
      : [],
  );
}

export class SessionChanges {
  private readonly files = new Map<string, FileLineChanges>();
  private readonly recorded = new Set<string>();

  record(toolCallId: string, changes: readonly FileChange[] | undefined): void {
    if (this.recorded.has(toolCallId)) return;
    const files = fileLineChanges(changes);
    if (!files.length) return;
    this.recorded.add(toolCallId);
    for (const file of files) this.add(file);
  }

  restore(saved?: readonly FileLineChanges[], transcript: readonly TranscriptItem[] = []): void {
    this.files.clear();
    this.recorded.clear();
    if (Array.isArray(saved)) {
      for (const file of saved) {
        const path = file?.path;
        if (typeof path === "string" && path && validLineChangeTotals(file)) {
          this.add({ path, added: file.added, removed: file.removed });
        }
      }
      return;
    }
    // Older sessions can recover recorded tool statistics, including compacted turns.
    const stack = [...transcript];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.kind === "compacted" && Array.isArray(item.originalItems)) stack.push(...item.originalItems);
      else if (item.kind === "tool" && item.status !== "running" && item.status !== "blocked") {
        this.record(item.id, item.fileChanges);
      }
    }
  }

  snapshot(): SessionChangesReport {
    const files = [...this.files.values()].map((file) => ({ ...file })).sort((a, b) => a.path.localeCompare(b.path));
    return { files, totals: sumLineChanges(files) };
  }

  private add(file: FileLineChanges): void {
    if (file.added === 0 && file.removed === 0) return;
    const previous = this.files.get(file.path);
    this.files.set(file.path, {
      path: file.path,
      added: (previous?.added ?? 0) + file.added,
      removed: (previous?.removed ?? 0) + file.removed,
    });
  }
}
