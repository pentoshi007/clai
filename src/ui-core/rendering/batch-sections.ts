
import { cleanToolOutputLines, presentOutput } from "./tool-presenter.js";

export type BatchSectionStatus = "ok" | "fail" | "cancelled" | "running";

export interface BatchSection {
  readonly index: number;
  readonly name: string;
  readonly ok: boolean;
  readonly status: BatchSectionStatus;
  readonly exitCode: number | undefined;
  readonly body: string;
}

const HEADER_RE =
  /^──\s+#(\d+)\s+([\w.]+)\s+\[(ok|fail|cancelled|running)(?:\s+exit=(\d+))?\]/;

function isBatchProgressLine(line: string): boolean {
  return /^\[batch\]/i.test(line.trim());
}

export function parseBatchSections(output: string): BatchSection[] {
  const ordered: BatchSection[] = [];
  const byIndex = new Map<number, number>();
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

export function isBatchToolName(name: string): boolean {
  return name === "tool.batch";
}

export interface BatchLiveLine {
  readonly text: string;
  readonly tone: "info" | "ok" | "fail" | "running";
}

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

export function buildBatchCardsFromSpool(raw: string): BatchSection[] {
  const settled = parseBatchSections(raw);
  const byIndex = new Map<number, BatchSection>();
  for (const s of settled) {
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

  for (const [idx, st] of tickState) {
    const existing = byIndex.get(idx);
    if (existing && existing.status !== "running") continue;
    if (existing && st.status === "running") continue;
    if (existing && existing.body.trim().length > 0 && st.status !== "running") {
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

export function formatBatchSectionForPager(section: BatchSection): string {
  const status = section.status ?? (section.ok ? "ok" : "fail");
  const exit =
    section.exitCode !== undefined ? ` exit=${section.exitCode}` : "";
  const head = `── #${section.index} ${section.name} [${status}${exit}]`;
  const body = section.body.trim();
  return body ? `${head}\n${body}` : head;
}

export function formatBatchForPager(
  sections: readonly BatchSection[],
  raw: string,
): string {
  if (sections.length === 0) return raw;
  if (raw.trim().length > 0) return raw;
  return sections.map(formatBatchSectionForPager).join("\n\n");
}

export function cleanBatchBodyLines(body: string): string[] {
  return cleanToolOutputLines(body);
}
