import { describe, expect, it } from "vitest";
import {
  batchSummaryLine,
  formatBatchSectionForPager,
  isBatchToolName,
  parseBatchSections,
  presentBatchSection,
} from "../../../src/ui-core/rendering/batch-sections.js";

const SAMPLE = [
  "── #1 dns.lookup [ok exit=0]",
  "A 1.2.3.4",
  "TTL 300",
  "",
  "── #2 web.fetch [fail exit=1]",
  "error: timeout",
  "retry later",
  "",
  "── #3 sysinfo [ok]",
  "darwin arm64",
].join("\n");

describe("parseBatchSections", () => {
  it("splits labeled tool.batch output into ordered sections", () => {
    const sections = parseBatchSections(SAMPLE);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({
      index: 1,
      name: "dns.lookup",
      ok: true,
      status: "ok",
      exitCode: 0,
    });
    expect(sections[0]!.body).toBe("A 1.2.3.4\nTTL 300");
    expect(sections[1]).toMatchObject({
      index: 2,
      name: "web.fetch",
      ok: false,
      status: "fail",
      exitCode: 1,
    });
    expect(sections[1]!.body).toBe("error: timeout\nretry later");
    expect(sections[2]).toMatchObject({
      index: 3,
      name: "sysinfo",
      ok: true,
      status: "ok",
      exitCode: undefined,
    });
    expect(sections[2]!.body).toBe("darwin arm64");
  });

  it("returns [] for ordinary tool output without section headers", () => {
    expect(parseBatchSections("hello\nworld\nok")).toEqual([]);
  });

  it("handles CRLF and empty bodies", () => {
    const raw = "── #1 fs.read [ok exit=0]\r\n\r\n── #2 fs.list [ok exit=0]\r\n";
    const sections = parseBatchSections(raw);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.body).toBe("");
    expect(sections[1]!.body).toBe("");
  });
});

describe("presentBatchSection / summary", () => {
  it("collapses long sub-tool bodies with a mid gap (Ctrl+O expands)", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const section = {
      index: 1,
      name: "fs.read",
      ok: true,
      status: "ok" as const,
      exitCode: 0,
      body,
    };
    const collapsed = presentBatchSection(section, false);
    expect(collapsed.glyph).toBe("✓");
    expect(collapsed.name).toBe("fs.read");
    expect(collapsed.lines[0]).toBe("line 1");
    expect(collapsed.lines.some((l) => l.startsWith("···"))).toBe(true);
    expect(collapsed.hiddenAboveCount).toBeGreaterThan(0);

    const expanded = presentBatchSection(section, true);
    expect(expanded.lines).toHaveLength(12);
    expect(expanded.hiddenAboveCount).toBe(0);
  });

  it("marks failed sections with ✗ and failed label", () => {
    const p = presentBatchSection(
      {
        index: 2,
        name: "web.fetch",
        ok: false,
        status: "fail",
        exitCode: 1,
        body: "nope",
      },
      true,
    );
    expect(p.glyph).toBe("✗");
    expect(p.statusLabel).toBe("failed (exit 1)");
    expect(p.lines).toEqual(["nope"]);
  });

  it("marks cancelled sections with ⊘", () => {
    const sections = parseBatchSections(
      "── #1 fs.read [fail exit=1]\nerr\n\n── #2 sysinfo [cancelled exit=130]\nCancelled — not run because #1 fs.read failed",
    );
    expect(sections[1]).toMatchObject({
      status: "cancelled",
      ok: false,
      exitCode: 130,
    });
    const p = presentBatchSection(sections[1]!, true);
    expect(p.glyph).toBe("⊘");
    expect(p.statusLabel).toBe("cancelled (exit 130)");
  });

  it("summarizes all-ok vs partial failure and cancelled", () => {
    const ok = parseBatchSections(
      "── #1 a [ok]\nx\n── #2 b [ok]\ny",
    );
    expect(batchSummaryLine(ok)).toBe("2 sub-tool(s) — all ok");
    const mixed = parseBatchSections(SAMPLE);
    expect(batchSummaryLine(mixed)).toBe("1 failed / 3 sub-tool(s)");
    const withCancel = parseBatchSections(
      "── #1 a [fail]\nx\n── #2 b [cancelled exit=130]\ny\n── #3 c [ok]\nz",
    );
    expect(batchSummaryLine(withCancel)).toBe(
      "1 failed, 1 cancelled / 3 sub-tool(s)",
    );
  });
});

describe("formatBatchSectionForPager / isBatchToolName", () => {
  it("rebuilds a labeled block for the individual pager", () => {
    const section = parseBatchSections(SAMPLE)[1]!;
    expect(formatBatchSectionForPager(section)).toBe(
      "── #2 web.fetch [fail exit=1]\nerror: timeout\nretry later",
    );
  });

  it("only treats tool.batch as a batch container name", () => {
    expect(isBatchToolName("tool.batch")).toBe(true);
    expect(isBatchToolName("shell.exec")).toBe(false);
  });
});
