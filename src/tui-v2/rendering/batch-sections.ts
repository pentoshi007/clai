/**
 * Parse and present tool.batch output as nested sub-tool sections
 * (classic TUI parity).
 *
 * Batch runners emit labeled sections:
 *   ── #1 dns.lookup [ok exit=0]
 *   …
 *   ── #2 web.fetch [fail exit=1]
 *   …
 */

import { cleanToolOutputLines, presentOutput } from "./tool-presenter.js";

export interface BatchSection {
  readonly index: number;
  readonly name: string;
  readonly ok: boolean;
  readonly exitCode: number | undefined;
  readonly body: string;
}

const HEADER_RE = /^──\s+#(\d+)\s+([\w.]+)\s+\[(ok|fail)(?:\s+exit=(\d+))?\]/;

/**
 * Split a completed tool.batch output into per-sub-tool sections.
 * Returns [] when the body is not in the labeled batch format.
 */
export function parseBatchSections(output: string): BatchSection[] {
  const sections: BatchSection[] = [];
  let current: {
    index: number;
    name: string;
    ok: boolean;
    exitCode: number | undefined;
  } | null = null;
  const bodyLines: string[] = [];

  for (const line of output.replace(/\r/g, "").split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current !== null) {
        sections.push({
          ...current,
          body: bodyLines.join("\n").trim(),
        });
        bodyLines.length = 0;
      }
      const exitCode = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
      current = {
        index: parseInt(m[1]!, 10),
        name: m[2]!,
        ok: m[3] === "ok",
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      };
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  if (current !== null) {
    sections.push({
      ...current,
      body: bodyLines.join("\n").trim(),
    });
  }
  return sections;
}

export interface BatchSectionPresentation {
  readonly glyph: string;
  readonly statusLabel: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly hiddenAboveCount: number;
  readonly hasBody: boolean;
}

/** Present one nested sub-tool for the card (collapsed head/tail or full). */
export function presentBatchSection(
  section: BatchSection,
  expanded: boolean,
): BatchSectionPresentation {
  const presented = presentOutput(section.body, undefined, expanded);
  // Prefer cleaned body even when presentOutput samples ends for huge text.
  const hasBody = section.body.trim().length > 0;
  return {
    glyph: section.ok ? "✓" : "✗",
    statusLabel: section.ok
      ? section.exitCode !== undefined
        ? `done (exit ${section.exitCode})`
        : "done"
      : section.exitCode !== undefined
        ? `failed (exit ${section.exitCode})`
        : "failed",
    name: section.name,
    lines: hasBody ? presented.lines : [],
    hiddenAboveCount: presented.hiddenAboveCount,
    hasBody,
  };
}

/** Human summary line under the parent batch header. */
export function batchSummaryLine(sections: readonly BatchSection[]): string {
  if (sections.length === 0) return "";
  const failed = sections.filter((s) => !s.ok).length;
  if (failed === 0) {
    return `${sections.length} sub-tool(s) — all ok`;
  }
  return `${failed}/${sections.length} sub-tool(s) failed`;
}

/** True when this tool item should use nested batch UI. */
export function isBatchToolName(name: string): boolean {
  return name === "tool.batch";
}

/**
 * Rebuild a single section as a labeled block for the pager (matches
 * runner formatting so the full-batch view stays familiar).
 */
export function formatBatchSectionForPager(section: BatchSection): string {
  const status = section.ok ? "ok" : "fail";
  const exit =
    section.exitCode !== undefined ? ` exit=${section.exitCode}` : "";
  const head = `── #${section.index} ${section.name} [${status}${exit}]`;
  const body = section.body.trim();
  return body ? `${head}\n${body}` : head;
}

/** Full batch body for the parent pager — prefer original spool order. */
export function formatBatchForPager(
  sections: readonly BatchSection[],
  raw: string,
): string {
  if (sections.length === 0) return raw;
  // Prefer the raw spool so nothing is lost; fall back to reassembly.
  if (raw.trim().length > 0) return raw;
  return sections.map(formatBatchSectionForPager).join("\n\n");
}

/** Preview helper used by tests — clean lines without expand sampling. */
export function cleanBatchBodyLines(body: string): string[] {
  return cleanToolOutputLines(body);
}
