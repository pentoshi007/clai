/**
 * Parse and present tool.batch output as nested sub-tool sections
 * (classic TUI parity).
 *
 * Batch runners emit labeled sections (streamed as each child finishes, and
 * again as the final body):
 *   ── #1 dns.lookup [ok exit=0]
 *   …
 *   ── #2 web.fetch [fail exit=1]
 *   …
 *
 * Live progress also includes `[batch] …` ticks. While the parent is still
 * running we merge settled sections with running placeholders so nested cards
 * appear expanded from the first start — same shape as single tool cards.
 */

import { cleanToolOutputLines, presentOutput } from "./tool-presenter.js";

export type BatchSectionStatus = "ok" | "fail" | "cancelled" | "running";

export interface BatchSection {
  readonly index: number;
  readonly name: string;
  /** True only when status is ok (back-compat for callers). */
  readonly ok: boolean;
  readonly status: BatchSectionStatus;
  readonly exitCode: number | undefined;
  readonly body: string;
}

const HEADER_RE =
  /^──\s+#(\d+)\s+([\w.]+)\s+\[(ok|fail|cancelled|running)(?:\s+exit=(\d+))?\]/;

/** Progress ticks are never part of a sub-tool body. */
function isBatchProgressLine(line: string): boolean {
  return /^\[batch\]/i.test(line.trim());
}

/**
 * Split a completed tool.batch output into per-sub-tool sections.
 * Returns [] when the body is not in the labeled batch format.
 * If the same index appears twice (live re-stream), the last header wins.
 */
export function parseBatchSections(output: string): BatchSection[] {
  const ordered: BatchSection[] = [];
  const byIndex = new Map<number, number>(); // index → position in ordered
  let current: {
    index: number;
    name: string;
    ok: boolean;
    status: BatchSectionStatus;
    exitCode: number | undefined;
  } | null = null;
  const bodyLines: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    const section: BatchSection = {
      ...current,
      body: bodyLines.join("\n").trim(),
    };
    bodyLines.length = 0;
    const prev = byIndex.get(section.index);
    if (prev !== undefined) {
      ordered[prev] = section;
    } else {
      byIndex.set(section.index, ordered.length);
      ordered.push(section);
    }
    current = null;
  };

  for (const line of output.replace(/\r/g, "").split("\n")) {
    if (isBatchProgressLine(line)) {
      // Progress ticks never belong in a section body.
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      const exitCode = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
      const status = m[3] as BatchSectionStatus;
      current = {
        index: parseInt(m[1]!, 10),
        name: m[2]!,
        status,
        ok: status === "ok",
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      };
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  // Drop pure running placeholders from final parse when a settled sibling
  // replaced them — callers that need live stubs use buildBatchCardsFromSpool.
  return ordered.filter((s) => s.status !== "running" || s.body.length > 0);
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
  const status = section.status ?? (section.ok ? "ok" : "fail");
  const bodyForPresent =
    status === "running" && !section.body.trim()
      ? "running…"
      : section.body;
  const presented = presentOutput(bodyForPresent, undefined, expanded);
  const hasBody = bodyForPresent.trim().length > 0;
  let glyph = "✗";
  let statusLabel = "failed";
  if (status === "running") {
    glyph = "●";
    statusLabel = "running";
  } else if (status === "ok") {
    glyph = "✓";
    statusLabel =
      section.exitCode !== undefined
        ? `done (exit ${section.exitCode})`
        : "done";
  } else if (status === "cancelled") {
    glyph = "⊘";
    statusLabel =
      section.exitCode !== undefined
        ? `cancelled (exit ${section.exitCode})`
        : "cancelled";
  } else if (section.exitCode !== undefined) {
    statusLabel = `failed (exit ${section.exitCode})`;
  }
  return {
    glyph,
    statusLabel,
    name: section.name,
    lines: hasBody ? presented.lines : [],
    hiddenAboveCount: presented.hiddenAboveCount,
    hasBody,
  };
}

/** Human summary line under the parent batch header. */
export function batchSummaryLine(sections: readonly BatchSection[]): string {
  if (sections.length === 0) return "";
  const running = sections.filter((s) => s.status === "running").length;
  const failed = sections.filter(
    (s) => (s.status ?? (s.ok ? "ok" : "fail")) === "fail",
  ).length;
  const cancelled = sections.filter(
    (s) => (s.status ?? (s.ok ? "ok" : "fail")) === "cancelled",
  ).length;
  const ok = sections.filter(
    (s) => (s.status ?? (s.ok ? "ok" : "fail")) === "ok",
  ).length;
  if (running > 0) {
    return `${ok} done · ${running} running · ${sections.length} total`;
  }
  if (failed === 0 && cancelled === 0) {
    return `${sections.length} sub-tool(s) — all ok`;
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  return `${parts.join(", ")} / ${sections.length} sub-tool(s)`;
}

/** True when this tool item should use nested batch UI. */
export function isBatchToolName(name: string): boolean {
  return name === "tool.batch";
}

export interface BatchLiveLine {
  readonly text: string;
  readonly tone: "info" | "ok" | "fail" | "running";
}

/**
 * Parse live `[batch] …` progress ticks (kept for tests / summary).
 * Prefer {@link buildBatchCardsFromSpool} for the live nested-card UI.
 */
export function parseBatchLiveProgress(raw: string): {
  readonly lines: readonly BatchLiveLine[];
  readonly summary: string;
} {
  const cards = buildBatchCardsFromSpool(raw);
  if (cards.length === 0) {
    const ticks = raw
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\[batch\]/i.test(l));
    const header = ticks.find((t) => /starting\b/i.test(t));
    return {
      lines: header
        ? [{ text: header.replace(/^\[batch\]\s*/i, ""), tone: "info" as const }]
        : [],
      summary: header
        ? header.replace(/^\[batch\]\s*/i, "")
        : ticks.length
          ? "batch running…"
          : "",
    };
  }
  const lines: BatchLiveLine[] = cards.map((c) => ({
    text: `#${c.index} ${c.name} · ${c.status}`,
    tone:
      c.status === "ok"
        ? ("ok" as const)
        : c.status === "running"
          ? ("running" as const)
          : c.status === "fail"
            ? ("fail" as const)
            : ("info" as const),
  }));
  return { lines, summary: batchSummaryLine(cards) };
}

interface TickState {
  name: string;
  status: BatchSectionStatus;
  exitCode: number | undefined;
}

/**
 * Merge streamed `── #N` sections with `[batch]` start/running ticks into an
 * ordered list of nested cards for live (and final) batch UI.
 */
export function buildBatchCardsFromSpool(raw: string): BatchSection[] {
  const settled = parseBatchSections(raw);
  const byIndex = new Map<number, BatchSection>();
  for (const s of settled) {
    // Prefer settled over running if both exist.
    if (s.status !== "running" || !byIndex.has(s.index)) {
      byIndex.set(s.index, s);
    }
  }

  const ticks = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[batch\]/i.test(l));

  const tickState = new Map<number, TickState>();
  for (const tick of ticks) {
    const body = tick.replace(/^\[batch\]\s*/i, "");
    const start = /^#(\d+)\s+([\w.]+)\s+starting/i.exec(body);
    const done =
      /^#(\d+)\s+([\w.]+)\s+(ok|fail|cancelled)(?:\s+exit=(\d+))?/i.exec(body);
    const running = /^#(\d+)\s+([\w.]+)\s+still running/i.exec(body);
    const err = /^#(\d+)\s+([\w.]+)\s+error:/i.exec(body);
    if (start) {
      const idx = parseInt(start[1]!, 10);
      const prev = tickState.get(idx);
      if (!prev || prev.status === "running") {
        tickState.set(idx, {
          name: start[2]!,
          status: "running",
          exitCode: undefined,
        });
      }
    } else if (done) {
      const idx = parseInt(done[1]!, 10);
      const st = done[3]!.toLowerCase() as BatchSectionStatus;
      const exit =
        done[4] !== undefined ? parseInt(done[4], 10) : undefined;
      tickState.set(idx, {
        name: done[2]!,
        status: st,
        exitCode: Number.isFinite(exit) ? exit : undefined,
      });
    } else if (running) {
      const idx = parseInt(running[1]!, 10);
      const prev = tickState.get(idx);
      if (!prev || prev.status === "running") {
        tickState.set(idx, {
          name: running[2]!,
          status: "running",
          exitCode: undefined,
        });
      }
    } else if (err) {
      const idx = parseInt(err[1]!, 10);
      tickState.set(idx, {
        name: err[2]!,
        status: "fail",
        exitCode: undefined,
      });
    }
  }

  // Fill running (or tick-only settled) stubs for indices not yet sectioned.
  for (const [idx, st] of tickState) {
    const existing = byIndex.get(idx);
    if (existing && existing.status !== "running") continue;
    if (existing && st.status === "running") continue;
    // Prefer full section body when we already have one.
    if (existing && existing.body.trim().length > 0 && st.status !== "running") {
      // Section may lack exit; prefer section.
      continue;
    }
    if (st.status === "running" || !existing) {
      byIndex.set(idx, {
        index: idx,
        name: st.name,
        status: st.status === "running" ? "running" : st.status,
        ok: st.status === "ok",
        exitCode: st.exitCode,
        body: existing?.body ?? "",
      });
    }
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Rebuild a single section as a labeled block for the pager (matches
 * runner formatting so the full-batch view stays familiar).
 */
export function formatBatchSectionForPager(section: BatchSection): string {
  const status = section.status ?? (section.ok ? "ok" : "fail");
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
