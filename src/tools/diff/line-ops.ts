

export type DiffOp = "context" | "add" | "del";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
  /** 1-based line in the old file; undefined for pure adds */
  readonly oldLine?: number | undefined;
  /** 1-based line in the new file; undefined for pure dels */
  readonly newLine?: number | undefined;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export interface DeletedSegment {
  /** 1-based line in the new file after which these deletions sit (0 = before first) */
  readonly atNewLine: number;
  readonly oldStart: number;
  readonly lines: readonly string[];
}

/** Max lines on either side before falling back to whole-file replace. */
export const DIFF_MAX_LINES = 20_000;

/** Max diff body lines in chat preview. */
export const PREVIEW_MAX_DIFF_LINES = 40;

/** Context lines around each change for chat. */
export const PREVIEW_CONTEXT = 1;

/**
 * Myers O(ND) line diff → list of ops over the full file (no hunk grouping).
 * Falls back to whole-file replace when sizes exceed caps.
 */
export function computeLineOps(
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return newLines.map((text, i) => ({
      op: "add" as const,
      text,
      newLine: i + 1,
    }));
  }
  if (m === 0) {
    return oldLines.map((text, i) => ({
      op: "del" as const,
      text,
      oldLine: i + 1,
    }));
  }

  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, n - suffix);
  const newMiddle = newLines.slice(prefix, m - suffix);
  const middleN = oldMiddle.length;
  const middleM = newMiddle.length;

  const prefixOps: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    prefixOps.push({
      op: "context",
      text: oldLines[i]!,
      oldLine: i + 1,
      newLine: i + 1,
    });
  }

  const suffixOps: DiffLine[] = [];
  for (let i = 0; i < suffix; i += 1) {
    suffixOps.push({
      op: "context",
      text: oldLines[n - suffix + i]!,
      oldLine: n - suffix + i + 1,
      newLine: m - suffix + i + 1,
    });
  }

  if (middleN > DIFF_MAX_LINES || middleM > DIFF_MAX_LINES || middleN * middleM > 4_000_000) {
    const middleReplace = wholeFileReplace(oldMiddle, newMiddle);
    const shiftedMiddle = middleReplace.map((op) => {
      if (op.op === "add") return { ...op, newLine: op.newLine! + prefix };
      if (op.op === "del") return { ...op, oldLine: op.oldLine! + prefix };
      return { ...op, oldLine: op.oldLine! + prefix, newLine: op.newLine! + prefix };
    });
    return [...prefixOps, ...shiftedMiddle, ...suffixOps];
  }

  const dp: Uint32Array[] = new Array(middleN + 1);
  for (let i = 0; i <= middleN; i += 1) dp[i] = new Uint32Array(middleM + 1);
  for (let i = 1; i <= middleN; i += 1) {
    const oi = oldMiddle[i - 1]!;
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= middleM; j += 1) {
      if (oi === newMiddle[j - 1]) row[j] = prev[j - 1]! + 1;
      else row[j] = Math.max(prev[j]!, row[j - 1]!);
    }
  }

  const rev: DiffLine[] = [];
  let i = middleN;
  let j = middleM;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldMiddle[i - 1] === newMiddle[j - 1]) {
      rev.push({
        op: "context",
        text: oldMiddle[i - 1]!,
        oldLine: i + prefix,
        newLine: j + prefix,
      });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rev.push({ op: "add", text: newMiddle[j - 1]!, newLine: j + prefix });
      j -= 1;
    } else {
      rev.push({ op: "del", text: oldMiddle[i - 1]!, oldLine: i + prefix });
      i -= 1;
    }
  }
  rev.reverse();

  return [...prefixOps, ...rev, ...suffixOps];
}

export function wholeFileReplace(
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffLine[] {
  const out: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i += 1) {
    out.push({ op: "del", text: oldLines[i]!, oldLine: i + 1 });
  }
  for (let i = 0; i < newLines.length; i += 1) {
    out.push({ op: "add", text: newLines[i]!, newLine: i + 1 });
  }
  return out;
}

/**
 * Group full-file ops into unified hunks with `context` lines of surrounding
 * unchanged content. Adjacent change regions within `context*2` merge.
 */
export function groupHunks(
  ops: readonly DiffLine[],
  context = PREVIEW_CONTEXT,
): DiffHunk[] {
  if (ops.length === 0) return [];

  // Mark change indices
  const isChange = ops.map((o) => o.op !== "context");
  if (!isChange.some(Boolean)) return [];

  // Expand change islands by context
  const include = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i += 1) {
    if (!isChange[i]) continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    for (let k = from; k <= to; k += 1) include[k] = true;
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!include[i]) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < ops.length && include[i]) i += 1;
    const slice = ops.slice(start, i);
    const first = slice[0]!;
    hunks.push({
      oldStart: first.oldLine ?? first.newLine ?? 1,
      newStart: first.newLine ?? first.oldLine ?? 1,
      lines: slice,
    });
  }
  return hunks;
}

/** Cap total preview lines across hunks; drop tail hunks with a sentinel. */
export function capPreviewHunks(
  hunks: readonly DiffHunk[],
  maxLines = PREVIEW_MAX_DIFF_LINES,
): { hunks: DiffHunk[]; truncated: boolean; omittedLines: number } {
  let used = 0;
  const out: DiffHunk[] = [];
  let omitted = 0;
  for (const h of hunks) {
    if (used >= maxLines) {
      omitted += h.lines.length;
      continue;
    }
    const room = maxLines - used;
    if (h.lines.length <= room) {
      out.push(h);
      used += h.lines.length;
    } else {
      out.push({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines.slice(0, room),
      });
      used += room;
      omitted += h.lines.length - room;
    }
  }
  return { hunks: out, truncated: omitted > 0, omittedLines: omitted };
}

export function countOps(ops: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === "add") added += 1;
    else if (o.op === "del") removed += 1;
  }
  return { added, removed };
}

export function collectAddedNewLines(ops: readonly DiffLine[]): number[] {
  const out: number[] = [];
  for (const o of ops) {
    if (o.op === "add" && typeof o.newLine === "number") out.push(o.newLine);
  }
  return out;
}

export function collectDeletedAt(ops: readonly DiffLine[]): DeletedSegment[] {
  const segments: DeletedSegment[] = [];
  let i = 0;
  // Track the last seen new-line number so deletions attach after it.
  let lastNew = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.op === "context" || op.op === "add") {
      if (typeof op.newLine === "number") lastNew = op.newLine;
      i += 1;
      continue;
    }
    // del run
    const lines: string[] = [];
    const oldStart = op.oldLine ?? 1;
    while (i < ops.length && ops[i]!.op === "del") {
      lines.push(ops[i]!.text);
      i += 1;
    }
    segments.push({ atNewLine: lastNew, oldStart, lines });
  }
  return segments;
}
