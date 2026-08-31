import { describe, expect, it } from "vitest";

import {
  evaluateChangedQuality,
  includeUntrackedChanges,
  parseAddedLines,
  parseNameStatus,
} from "../../scripts/quality/changed.mjs";
import { buildReport } from "../../scripts/quality/report.mjs";

function report({ files = [], functions = [], findings = [] } = {}) {
  return { files, functions, typeSyntaxFindings: findings };
}

function file(path: string, lines: number, limit = 500) {
  return { file: path, lines, limit };
}

function fn(
  path: string,
  name: string,
  line: number,
  endLine: number,
  cyclomatic: number,
  cognitive: number,
  halsteadDifficulty: number,
) {
  return { file: path, name, line, endLine, cyclomatic, cognitive, halsteadDifficulty };
}

describe("changed path parsing", () => {
  it("parses added, modified, and renamed name-status records", () => {
    expect(parseNameStatus("A\0src/a.ts\0M\0src/b.ts\0R100\0src/old.ts\0src/new.ts\0")).toEqual([
      { status: "A", path: "src/a.ts" },
      { status: "M", path: "src/b.ts" },
      { status: "R", previousPath: "src/old.ts", path: "src/new.ts" },
    ]);
  });

  it("collects only post-change line numbers from zero-context hunks", () => {
    const diff = [
      "@@ -2,2 +2,3 @@",
      "-old",
      "+first",
      "+second",
      " unchanged",
      "@@ -10,0 +12,1 @@",
      "+last",
    ].join("\n");
    expect([...parseAddedLines(diff)]).toEqual([2, 3, 12]);
  });

  it("includes untracked paths without duplicating tracked changes", () => {
    expect(
      includeUntrackedChanges(
        [{ status: "M", path: "src/existing.ts" }],
        "src/new.ts\0src/existing.ts\0",
      ),
    ).toEqual([
      { status: "M", path: "src/existing.ts" },
      { status: "A", path: "src/new.ts" },
    ]);
  });
});

describe("changed quality evaluation", () => {
  it("rejects oversized new files and over-limit new functions", () => {
    const path = "src/new.ts";
    const result = evaluateChangedQuality({
      current: report({
        files: [file(path, 500)],
        functions: [fn(path, "large", 1, 100, 22, 22, 80)],
      }),
      baseline: report(),
      changes: [{ status: "A", path, addedLines: new Set([1]) }],
    });
    expect(result.failures).toEqual([
      "src/new.ts: 500 lines must be < 500",
      "src/new.ts#large@1: cyclomatic 22 must be < 22",
      "src/new.ts#large@1: cognitive 22 must be < 22",
      "src/new.ts#large@1: Halstead difficulty 80 must be < 80",
    ]);
  });

  it("allows held or improved legacy violations", () => {
    const path = "src/legacy.ts";
    const result = evaluateChangedQuality({
      current: report({
        files: [file(path, 900)],
        functions: [fn(path, "legacy", 10, 80, 30, 28, 90)],
      }),
      baseline: report({
        files: [file(path, 950)],
        functions: [fn(path, "legacy", 20, 90, 31, 29, 91)],
      }),
      changes: [{ status: "M", path, addedLines: new Set([30]) }],
    });
    expect(result.failures).toEqual([]);
    expect(result.held).toHaveLength(2);
  });

  it("rejects a regression in a legacy violation", () => {
    const path = "src/legacy.ts";
    const result = evaluateChangedQuality({
      current: report({
        files: [file(path, 951)],
        functions: [fn(path, "legacy", 10, 80, 32, 29, 91)],
      }),
      baseline: report({
        files: [file(path, 950)],
        functions: [fn(path, "legacy", 20, 90, 31, 29, 91)],
      }),
      changes: [{ status: "M", path, addedLines: new Set([30]) }],
    });
    expect(result.failures).toEqual([
      "src/legacy.ts: 951 lines must be < 500",
      "src/legacy.ts#legacy@10: cyclomatic 32 must be < 22",
    ]);
  });

  it("rejects gated type syntax introduced on an added line", () => {
    const path = "src/value.ts";
    const result = evaluateChangedQuality({
      current: report({
        files: [file(path, 20)],
        findings: [
          { file: path, line: 8, column: 12, category: "explicitAny", detail: "any" },
          { file: path, line: 9, column: 12, category: "unknownBoundary", detail: "unknown" },
        ],
      }),
      baseline: report(),
      changes: [{ status: "A", path, addedLines: new Set([8, 9]) }],
    });
    expect(result.failures).toEqual(["src/value.ts:8:12: new explicitAny (any)"]);
  });
});

  it("includes end lines when changed-code attribution requests them", () => {
    const measured = buildReport({ includeFunctionRanges: true });
    expect(measured.functions.length).toBeGreaterThan(0);
    expect(measured.functions.every((entry) => typeof entry.endLine === "number")).toBe(true);
  }, 30_000);

  it("fails closed when a modified function has no end range", () => {
    const path = "src/legacy.ts";
    const currentFunction = {
      file: path,
      name: "legacy",
      line: 10,
      cyclomatic: 30,
      cognitive: 28,
      halsteadDifficulty: 90,
    };
    expect(() =>
      evaluateChangedQuality({
        current: report({ files: [file(path, 100)], functions: [currentFunction] }),
        baseline: report({ files: [file(path, 100)], functions: [currentFunction] }),
        changes: [{ status: "M", path, addedLines: new Set([20]) }],
      }),
    ).toThrow("quality:changed: missing endLine for src/legacy.ts#legacy@10");
  });
