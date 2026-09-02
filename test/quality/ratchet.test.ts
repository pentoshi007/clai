import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  BASELINE_PATH,
  compareBaselines,
  RATCHETED_TYPE_CATEGORIES,
} from "../../scripts/quality/ratchet.mjs";
import { LIMITS } from "../../scripts/quality/config.mjs";

/**
 * Monotonic ratchet comparator (Phase 0, P0-07).
 *
 * Every regression class is proved with a synthetic baseline pair, and the
 * committed baseline is asserted to be well-formed and sorted. A comparator that
 * has never been observed rejecting a regression is not a gate.
 */

const EMPTY = Object.freeze({
  schemaVersion: 1,
  limits: { ...LIMITS },
  filesOverLineLimit: [],
  maxima: { fileLines: 100, cyclomatic: 5, cognitive: 5, halsteadDifficulty: 10 },
  functionsOverCyclomatic: [],
  functionsOverCognitive: [],
  functionsOverHalstead: [],
  typeSyntax: {
    explicitAny: 0,
    unknownBoundary: 0,
    unknownNarrowing: 0,
    unknownInternal: 0,
    doubleAssertion: 0,
    broadCast: 0,
    suppression: 0,
  },
});

function withOverrides(overrides: Record<string, unknown>) {
  return structuredClone({ ...EMPTY, ...overrides });
}

describe("ratchet comparator — regressions fail", () => {
  it("fails when a file newly reaches the line limit", () => {
    const result = compareBaselines(
      EMPTY,
      withOverrides({ filesOverLineLimit: ["src/new/big.ts"] }),
    );
    expect(result.regressions).toContain("new file over line limit: src/new/big.ts");
  });

  it("fails when a function newly exceeds a complexity limit", () => {
    const result = compareBaselines(
      EMPTY,
      withOverrides({
        functionsOverCyclomatic: ["src/a.ts#handle@10"],
        functionsOverCognitive: ["src/b.ts#render@20"],
        functionsOverHalstead: ["src/c.ts#decode@30"],
      }),
    );
    expect(result.regressions).toContain("new cyclomatic violation: src/a.ts#handle@10");
    expect(result.regressions).toContain("new cognitive violation: src/b.ts#render@20");
    expect(result.regressions).toContain("new Halstead violation: src/c.ts#decode@30");
  });

  it("fails when any maximum is raised", () => {
    const result = compareBaselines(
      EMPTY,
      withOverrides({
        maxima: { fileLines: 101, cyclomatic: 5, cognitive: 5, halsteadDifficulty: 10 },
      }),
    );
    expect(result.regressions).toContain("raised maximum fileLines: 100 -> 101");
  });

  it("fails when a ratcheted type-syntax count increases", () => {
    for (const category of RATCHETED_TYPE_CATEGORIES) {
      const result = compareBaselines(
        EMPTY,
        withOverrides({ typeSyntax: { ...EMPTY.typeSyntax, [category]: 1 } }),
      );
      expect(result.regressions).toContain(`increased ${category}: 0 -> 1`);
    }
  });

  it("does not fail when boundary-valid unknown increases", () => {
    // Boundary `unknown` is correct by policy, so it is reported but not gated.
    const result = compareBaselines(
      EMPTY,
      withOverrides({ typeSyntax: { ...EMPTY.typeSyntax, unknownBoundary: 25 } }),
    );
    expect(result.regressions).toEqual([]);
  });

  it("fails when a limit is loosened to make a change pass", () => {
    const result = compareBaselines(
      EMPTY,
      withOverrides({ limits: { ...LIMITS, cyclomatic: LIMITS.cyclomatic + 1 } }),
    );
    expect(result.regressions).toContain(
      `loosened limit cyclomatic: ${LIMITS.cyclomatic} -> ${LIMITS.cyclomatic + 1}`,
    );
  });

  it("fails when a metric maximum disappears from the report", () => {
    const broken = withOverrides({ maxima: { fileLines: 100, cyclomatic: 5, cognitive: 5 } });
    const result = compareBaselines(EMPTY, broken);
    expect(result.regressions).toContain("missing maximum for halsteadDifficulty");
  });
});

describe("ratchet comparator — improvements and holds", () => {
  const legacy = withOverrides({
    filesOverLineLimit: ["src/legacy/a.ts", "src/legacy/b.ts"],
    functionsOverCyclomatic: ["src/legacy/a.ts#huge@1"],
    maxima: { fileLines: 900, cyclomatic: 40, cognitive: 60, halsteadDifficulty: 90 },
    typeSyntax: { ...EMPTY.typeSyntax, explicitAny: 40 },
  });

  it("passes while legacy debt is merely held", () => {
    const result = compareBaselines(legacy, structuredClone(legacy));
    expect(result.regressions).toEqual([]);
    expect(result.held).toBe(3);
  });

  it("reports resolved findings and lowered maxima as improvements", () => {
    const improved = withOverrides({
      filesOverLineLimit: ["src/legacy/a.ts"],
      functionsOverCyclomatic: [],
      maxima: { fileLines: 700, cyclomatic: 30, cognitive: 60, halsteadDifficulty: 90 },
      typeSyntax: { ...EMPTY.typeSyntax, explicitAny: 12 },
    });
    const result = compareBaselines(legacy, improved);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toContain("resolved file over line limit: src/legacy/b.ts");
    expect(result.improvements).toContain("resolved cyclomatic violation: src/legacy/a.ts#huge@1");
    expect(result.improvements).toContain("lowered maximum fileLines: 900 -> 700");
    expect(result.improvements).toContain("reduced explicitAny: 40 -> 12");
  });

  it("detects a mixed change as a regression even when something improved", () => {
    const mixed = withOverrides({
      filesOverLineLimit: ["src/legacy/a.ts", "src/new/c.ts"],
      functionsOverCyclomatic: [],
      maxima: legacy.maxima,
      typeSyntax: legacy.typeSyntax,
    });
    const result = compareBaselines(legacy, mixed);
    expect(result.regressions).toContain("new file over line limit: src/new/c.ts");
    expect(result.improvements.length).toBeGreaterThan(0);
  });

  it("holds function violations when only source lines shift", () => {
    const before = withOverrides({
      functionsOverCyclomatic: ["src/a.ts#handle@10"],
      functionsOverCognitive: ["src/a.ts#<anonymous>@20", "src/a.ts#<anonymous>@30"],
    });
    const after = withOverrides({
      functionsOverCyclomatic: ["src/a.ts#handle@40"],
      functionsOverCognitive: ["src/a.ts#<anonymous>@50", "src/a.ts#<anonymous>@60"],
    });
    const result = compareBaselines(before, after);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.held).toBe(3);
  });

  it("still detects added and resolved duplicate-name violations", () => {
    const before = withOverrides({
      functionsOverCyclomatic: ["src/a.ts#<anonymous>@10", "src/a.ts#<anonymous>@20"],
    });
    const added = withOverrides({
      functionsOverCyclomatic: [
        "src/a.ts#<anonymous>@30",
        "src/a.ts#<anonymous>@40",
        "src/a.ts#<anonymous>@50",
      ],
    });
    const removed = withOverrides({
      functionsOverCyclomatic: ["src/a.ts#<anonymous>@30"],
    });
    expect(compareBaselines(before, added).regressions).toEqual([
      "new cyclomatic violation: src/a.ts#<anonymous>@50",
    ]);
    expect(compareBaselines(before, removed).improvements).toEqual([
      "resolved cyclomatic violation: src/a.ts#<anonymous>@20",
    ]);
  });
});

describe("committed metrics baseline", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  it("uses the reviewed limits without local relaxation", () => {
    expect(baseline.limits).toEqual({ ...LIMITS });
  });

  it("stores every finding list sorted for reviewable diffs", () => {
    for (const key of [
      "filesOverLineLimit",
      "functionsOverCyclomatic",
      "functionsOverCognitive",
      "functionsOverHalstead",
    ] as const) {
      const list = baseline[key] as string[];
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("records the legacy debt that Phases 1-8 must remove", () => {
    // Non-zero at the anchor: the ratchet exists to drive these down. If any of
    // these ever reads zero, the corresponding terminal gate can become blocking.
    expect(baseline.filesOverLineLimit.length).toBeGreaterThan(0);
    expect(baseline.maxima.fileLines).toBeGreaterThan(LIMITS.fileLines);
    expect(baseline.typeSyntax.explicitAny).toBeGreaterThan(0);
  });
});
