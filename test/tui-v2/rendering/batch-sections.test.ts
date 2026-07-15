import { describe, expect, it } from "vitest";
import {
  batchSummaryLine,
  formatBatchSectionForPager,
  isBatchToolName,
  parseBatchSections,
  presentBatchSection,
} from "../../../src/tui-v2/rendering/batch-sections.js";

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
      exitCode: 0,
    });
    expect(sections[0]!.body).toBe("A 1.2.3.4\nTTL 300");
    expect(sections[1]).toMatchObject({
      index: 2,
      name: "web.fetch",
      ok: false,
      exitCode: 1,
    });
    expect(sections[1]!.body).toBe("error: timeout\nretry later");
    expect(sections[2]).toMatchObject({
      index: 3,
      name: "sysinfo",
      ok: true,
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
        exitCode: 1,
        body: "nope",
      },
      true,
    );
    expect(p.glyph).toBe("✗");
    expect(p.statusLabel).toBe("failed (exit 1)");
    expect(p.lines).toEqual(["nope"]);
  });

  it("summarizes all-ok vs partial failure", () => {
    const ok = parseBatchSections(
      "── #1 a [ok]\nx\n── #2 b [ok]\ny",
    );
    expect(batchSummaryLine(ok)).toBe("2 sub-tool(s) — all ok");
    const mixed = parseBatchSections(SAMPLE);
    expect(batchSummaryLine(mixed)).toBe("1/3 sub-tool(s) failed");
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
