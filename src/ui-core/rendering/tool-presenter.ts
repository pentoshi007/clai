
import type { BoundedTextState } from "../../app/events/event-buffer.js";
import type { ToolItem, ToolStatus } from "../state/transcript-types.js";
import {
  fileToolTitle,
  isFileMutationTool,
  type FileChangeKind,
} from "../../tools/file-diff.js";
import { sanitizeDisplayText } from "./sanitize-display.js";

const STATUS_GLYPH: Record<ToolStatus, string> = {
  queued: "○",
  running: "●",
  ok: "✓",
  failed: "✗",
  blocked: "⊘",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  queued: "queued",
  running: "running",
  ok: "done",
  failed: "failed",
  blocked: "blocked",
};

export interface ToolPresentation {
  readonly glyph: string;
  readonly statusLabel: string;
  readonly name: string;
  readonly argsLabel: string | undefined;
  readonly argsDisplay: string | undefined;
  readonly detail: string | undefined;
  readonly pathLine: string | undefined;
  readonly isFileDiff: boolean;
}

function pathFromArgsDisplay(
  toolName: string,
  argsDisplay: string | undefined,
): string {
  const raw = (argsDisplay ?? "").trim();
  if (!raw) return "";
  if (!raw.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.path === "string" && parsed.path) return parsed.path;
    if (Array.isArray(parsed.files)) {
      const n = parsed.files.length;
      return n > 0 ? `${n} file(s)` : "files";
    }
  } catch {
  }
  return toolName === "fs.writeMany" ? "files" : "";
}

const ARGS_PREVIEW_MAX_LINES = 3;

const FAILURE_DETAIL_CHARS = 120;

export function clampArgsDisplay(raw: string | undefined): string | undefined {
  if (!raw) return raw ?? undefined;
  const lines = raw.split("\n");
  const kept = lines.slice(0, ARGS_PREVIEW_MAX_LINES);
  const hidden = lines.length - kept.length;
  if (hidden > 0) {
    kept.push(`··· +${hidden} more line${hidden === 1 ? "" : "s"} · click for full ···`);
  }
  return kept.join("\n");
}

export function presentTool(item: ToolItem): ToolPresentation {
  const fileDiff =
    isFileMutationTool(item.name) ||
    Boolean(item.fileChanges && item.fileChanges.length > 0);

  let name = item.name;
  let argsLabel: string | undefined = item.argsDisplay
    ? item.name === "shell.exec"
      ? "command"
      : "input"
    : undefined;
  let argsDisplay = clampArgsDisplay(item.argsDisplay || undefined);
  let pathLine: string | undefined;

  if (fileDiff) {
    const kind = item.fileChanges?.[0]?.kind as FileChangeKind | undefined;
    let pathOrDisplay = "";
    if (item.name === "fs.writeMany" && item.fileChanges?.length) {
      pathOrDisplay = `${item.fileChanges.length} file(s)`;
    } else if (item.fileChanges?.[0]?.path) {
      pathOrDisplay = item.fileChanges[0].path;
    } else if (item.name === "fs.writeMany") {
      pathOrDisplay =
        item.status === "failed" || item.status === "blocked" ? "files" : "";
    } else {
      pathOrDisplay = pathFromArgsDisplay(item.name, item.argsDisplay);
    }
    const titled = fileToolTitle(item.name, item.status, pathOrDisplay, kind);
    name = titled.title;
    pathLine =
      item.name === "fs.writeMany"
        ? undefined
        : titled.pathLine ?? item.fileChanges?.[0]?.path;
    argsLabel = undefined;
    argsDisplay = undefined;
  }

  let detail: string | undefined;
  if (item.status === "blocked") {
    detail = item.reason;
  } else if (item.status === "failed" && item.summary) {
    const short = item.summary.split("\n")[0]?.trim();
    if (short && !/^Full output saved/i.test(short)) {
      detail =
        short.length <= FAILURE_DETAIL_CHARS
          ? short
          : `${short.slice(0, FAILURE_DETAIL_CHARS - 1).trimEnd()}…`;
    }
  }
  let statusLabel = STATUS_LABEL[item.status];
  if (
    item.exitCode !== undefined &&
    item.exitCode !== 0 &&
    (item.status === "failed" || item.status === "ok")
  ) {
    const why =
      item.exitCode === 127
        ? "not found"
        : item.exitCode === 126
          ? "not executable"
          : undefined;
    statusLabel = why
      ? `${statusLabel} · ${item.exitCode} · ${why}`
      : `${statusLabel} · ${item.exitCode}`;
  }
  return {
    glyph: STATUS_GLYPH[item.status],
    statusLabel,
    name,
    argsLabel,
    argsDisplay,
    detail,
    pathLine,
    isFileDiff: item.name !== "fs.delete" && Boolean(item.fileChanges?.length),
  };
}

export function writeManyFileLabel(change: {
  readonly path: string;
  readonly kind: string;
}): string {
  const base = change.path.split(/[/\\]/).pop() || change.path;
  const mark =
    change.kind === "create" ? "+" : change.kind === "overwrite" ? "~" : "·";
  return `${mark} ${base}`;
}

export interface OutputPresentation {
  readonly lines: readonly string[];
  readonly hiddenAboveCount: number;
  readonly truncatedNotice: string | undefined;
}

const COLLAPSED_HEAD_LINES = 4;
const COLLAPSED_TAIL_LINES = 4;
const EXPANDED_SAFE_CHARS = 400_000;
const EXPANDED_SAFE_LINES = 4_000;
const SAMPLE_CHARS = 4_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isSpoolNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t === "ok" || t === "failed" || t === "✓" || t === "✗") return true;
  if (/^full output saved to\b/i.test(t)) return true;
  if (/^Full output saved to:\s*/i.test(t)) return true;
  if (/^\.\.\. full output saved to\b/i.test(t)) return true;
  if (/^\.\.\. live preview truncated/i.test(t)) return true;
  if (/^\(tool still running/i.test(t)) return true;
  if (t === "...") return true;
  if (/^artifact:\s+/i.test(t)) return true;
  if (/^\[batch\]\b/i.test(t)) return true;
  return false;
}

export function sampleEnds(raw: string, eachEnd = SAMPLE_CHARS): string {
  if (raw.length <= eachEnd * 2) return raw;
  return `${raw.slice(0, eachEnd)}\n…\n${raw.slice(-eachEnd)}`;
}

function roughLineCount(raw: string): number {
  if (!raw) return 0;
  let n = 1;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

const PRINTABLE_CARET_CSI = /\^\[\[[0-9;?]*[ -/]*[@-~]/g;

function stripPrintableCaretCsi(text: string): string {
  return text.replace(PRINTABLE_CARET_CSI, "");
}

export function cleanToolOutputLines(raw: string): string[] {
  const safe = stripPrintableCaretCsi(sanitizeDisplayText(raw));
  if (safe.length === 0) return [];
  const out: string[] = [];
  let lastKept: string | undefined;
  for (const line of safe.split("\n")) {
    if (isSpoolNoiseLine(line)) continue;
    if (line.trim() === "" && (out.length === 0 || lastKept === "")) continue;
    if (line === lastKept) continue;
    const deLinked = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    out.push(deLinked);
    lastKept = line;
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

export function evidencePreviewLines(
  toolName: string | undefined,
  cleaned: readonly string[],
): string[] | undefined {
  if (!toolName || cleaned.length === 0) return undefined;
  if (toolName === "web.search") {
    const out: string[] = [];
    for (const line of cleaned) {
      if (out.length >= 8) break;
      const t = line.trim();
      if (!t) continue;
      if (
        out.length < 2 ||
        /^https?:\/\//i.test(t) ||
        /"title"\s*:/i.test(t) ||
        /"url"\s*:/i.test(t) ||
        /^\d+\.\s/.test(t) ||
        /^[-*]\s/.test(t)
      ) {
        out.push(line);
      } else if (out.length < 3) {
        out.push(line);
      }
    }
    return out.length >= 2 ? out.slice(0, 8) : undefined;
  }
  if (toolName === "web.fetch" || toolName === "http.fetch") {
    const out: string[] = [];
    let bodyLines = 0;
    for (const line of cleaned) {
      const t = line.trim();
      if (!t) {
        if (out.length > 0 && bodyLines > 0) break;
        continue;
      }
      out.push(line);
      if (out.length <= 2) continue;
      bodyLines += 1;
      if (bodyLines >= 4 || out.length >= 8) break;
    }
    return out.length >= 2 ? out : undefined;
  }
  return undefined;
}

export function presentOutput(
  tail: string,
  state: BoundedTextState | undefined,
  expanded: boolean,
  toolName?: string,
): OutputPresentation {
  const totalLines = roughLineCount(tail);
  const truncatedNotice = state?.truncated
    ? `output truncated in memory (${formatBytes(state.droppedBytes)} dropped; full output saved to disk)`
    : undefined;

  if (expanded) {
    const source =
      tail.length <= EXPANDED_SAFE_CHARS
        ? tail
        : sampleEnds(tail, Math.floor(EXPANDED_SAFE_CHARS / 2));
    const cleaned = cleanToolOutputLines(source);
    if (cleaned.length <= EXPANDED_SAFE_LINES) {
      const hidden =
        source !== tail
          ? Math.max(0, totalLines - cleaned.length)
          : 0;
      return { lines: cleaned, hiddenAboveCount: hidden, truncatedNotice };
    }
    const head = cleaned.slice(0, COLLAPSED_HEAD_LINES);
    const visibleTail = cleaned.slice(-COLLAPSED_TAIL_LINES);
    const hiddenAboveCount = Math.max(
      0,
      cleaned.length - COLLAPSED_HEAD_LINES - COLLAPSED_TAIL_LINES,
    );
    return {
      lines: [...head, `··· ${hiddenAboveCount} lines more · open pager ···`, ...visibleTail],
      hiddenAboveCount,
      truncatedNotice,
    };
  }

  const source = sampleEnds(tail, SAMPLE_CHARS);
  const cleaned = cleanToolOutputLines(source);
  const headCount = COLLAPSED_HEAD_LINES;
  const tailCount = COLLAPSED_TAIL_LINES;
  const budget = headCount + tailCount;

  let lines: string[];
  let hiddenAboveCount = 0;

  const evidence = !expanded
    ? evidencePreviewLines(toolName, cleaned)
    : undefined;

  if (evidence && evidence.length > 0 && cleaned.length > budget) {
    const rest = cleaned.length - evidence.length;
    hiddenAboveCount = Math.max(0, totalLines - evidence.length, rest);
    lines =
      hiddenAboveCount > 0
        ? [...evidence, `··· ${hiddenAboveCount} lines more ···`]
        : evidence;
  } else if (cleaned.length <= budget) {
    lines = cleaned;
    if (source !== tail && totalLines > cleaned.length) {
      hiddenAboveCount = Math.max(0, totalLines - cleaned.length);
    }
  } else {
    const head = cleaned.slice(0, headCount);
    const visibleTail = cleaned.slice(-tailCount);
    hiddenAboveCount = Math.max(
      totalLines - headCount - tailCount,
      cleaned.length - headCount - tailCount,
    );
    lines =
      hiddenAboveCount > 0
        ? [...head, `··· ${hiddenAboveCount} lines more ···`, ...visibleTail]
        : [...head, ...visibleTail];
  }

  return { lines, hiddenAboveCount, truncatedNotice };
}
