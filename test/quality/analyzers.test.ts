import { describe, expect, it } from "vitest";
import ts from "typescript";

import { crapScore, measureFunctions } from "../../scripts/quality/ast-metrics.mjs";
import {
  analyzeTypeSyntax,
  summarizeTypeSyntax,
} from "../../scripts/quality/type-syntax.mjs";
import { countPhysicalLines } from "../../scripts/quality/report.mjs";
import { lineLimitFor, LIMITS, isGenerated } from "../../scripts/quality/config.mjs";

/**
 * Analyzer correctness (Phase 0, P0-04/P0-05).
 *
 * Synthetic fixtures with hand-computed expectations. A metric that cannot be
 * demonstrated on a known input is a guess, not evidence — and both `.ts` and
 * `.tsx` must be handled by the same code path the build uses.
 */

function parse(text: string, fileName = "fixture.ts") {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

describe("cyclomatic complexity", () => {
  it("counts 1 for a straight-line function", () => {
    const [fn] = measureFunctions(parse("function plain(a: number) { return a + 1; }"));
    expect(fn.name).toBe("plain");
    expect(fn.cyclomatic).toBe(1);
  });

  it("counts each decision point exactly once", () => {
    // 1 base + if + else-if + for + while + case + case + catch + ternary
    // + && + || + ?? = 12. `default:` is not a decision point.
    const source = `
      function decisions(input: number, flag: boolean, maybe?: string) {
        if (input > 1) { return 1; }
        else if (input > 0) { return 2; }
        for (let i = 0; i < input; i += 1) { input += i; }
        while (flag) { flag = false; }
        switch (input) {
          case 1: break;
          case 2: break;
          default: break;
        }
        try { JSON.parse("{}"); } catch { return 0; }
        const t = flag ? 1 : 2;
        const and = flag && input > 0;
        const or = flag || input < 0;
        const nullish = maybe ?? "fallback";
        return t + Number(and) + Number(or) + nullish.length;
      }
    `;
    const [fn] = measureFunctions(parse(source));
    expect(fn.name).toBe("decisions");
    expect(fn.cyclomatic).toBe(12);
  });

  it("measures nested functions separately rather than folding them in", () => {
    const source = `
      function outer(flag: boolean) {
        const inner = (x: number) => (x > 0 ? 1 : 2);
        if (flag) return inner(1);
        return inner(0);
      }
    `;
    const measured = measureFunctions(parse(source));
    const outer = measured.find((entry) => entry.name === "outer");
    const inner = measured.find((entry) => entry.name === "inner");
    expect(outer?.cyclomatic).toBe(2);
    expect(inner?.cyclomatic).toBe(2);
  });
});

describe("cognitive complexity", () => {
  it("penalizes nesting and charges else/else-if without nesting", () => {
    // if(+1) > nested if(+2) > nested for(+3) = 6, plus plain else(+1) = 7
    const source = `
      function nested(a: number, b: number) {
        if (a > 0) {
          if (b > 0) {
            for (let i = 0; i < a; i += 1) { b += i; }
          }
        } else {
          b -= 1;
        }
        return b;
      }
    `;
    const [fn] = measureFunctions(parse(source));
    expect(fn.cognitive).toBe(7);
  });

  it("charges one increment per sequence of like logical operators", () => {
    const source = `
      function logic(a: boolean, b: boolean, c: boolean, d: boolean) {
        return (a && b && c) || d;
      }
    `;
    const [fn] = measureFunctions(parse(source));
    // one && sequence (+1) and one || (+1)
    expect(fn.cognitive).toBe(2);
  });

  it("charges labeled jumps", () => {
    const source = `
      function labeled(items: number[]) {
        outer: for (const item of items) {
          if (item > 2) { continue outer; }
        }
        return items.length;
      }
    `;
    const [fn] = measureFunctions(parse(source));
    // for(+1) + if nested(+2) + labeled continue(+1)
    expect(fn.cognitive).toBe(4);
  });
});

describe("Halstead metrics", () => {
  it("reports vocabulary, volume and difficulty for a known body", () => {
    const [fn] = measureFunctions(parse("function add(a: number, b: number) { return a + b; }"));
    expect(fn.halstead.distinctOperators).toBeGreaterThan(0);
    expect(fn.halstead.distinctOperands).toBeGreaterThan(0);
    expect(fn.halstead.volume).toBeGreaterThan(0);
    expect(fn.halstead.difficulty).toBeGreaterThan(0);
    // difficulty = (n1 / 2) * (N2 / n2)
    const expected =
      (fn.halstead.distinctOperators / 2) *
      (fn.halstead.totalOperands / fn.halstead.distinctOperands);
    expect(fn.halstead.difficulty).toBeCloseTo(Math.round(expected * 100) / 100, 2);
  });

  it("grows with a more complex body", () => {
    const simple = measureFunctions(parse("function s(a: number) { return a; }"))[0];
    const complex = measureFunctions(
      parse(
        "function c(a: number, b: number, d: number) { return a * b + d / (a - b) + Math.max(a, b, d); }",
      ),
    )[0];
    expect(complex.halstead.difficulty).toBeGreaterThan(simple.halstead.difficulty);
  });
});

describe("TSX compatibility", () => {
  it("measures components and handlers in .tsx sources", () => {
    const source = `
      import React from "react";
      export function Panel({ items, open }: { items: string[]; open: boolean }) {
        const label = open ? "open" : "closed";
        return (
          <div title={label}>
            {items.map((item) => (item.length > 2 ? <span key={item}>{item}</span> : null))}
          </div>
        );
      }
    `;
    const measured = measureFunctions(parse(source, "fixture.tsx"));
    const panel = measured.find((entry) => entry.name === "Panel");
    expect(panel).toBeDefined();
    expect(panel!.cyclomatic).toBe(2);
    expect(measured.length).toBeGreaterThanOrEqual(2); // component + map callback
    expect(panel!.halstead.difficulty).toBeGreaterThan(0);
  });
});

describe("CRAP score", () => {
  it("equals the cyclomatic value at full coverage", () => {
    expect(crapScore(10, 1)).toBe(10);
  });

  it("applies comp^2 * (1 - cov)^3 + comp", () => {
    // 10^2 * 0.5^3 + 10 = 22.5
    expect(crapScore(10, 0.5)).toBe(22.5);
    // 5^2 * 1 + 5 = 30
    expect(crapScore(5, 0)).toBe(30);
  });

  it("clamps out-of-range coverage instead of producing nonsense", () => {
    expect(crapScore(4, 1.5)).toBe(4);
    expect(crapScore(4, -1)).toBe(crapScore(4, 0));
  });
});

describe("type-syntax classification", () => {
  const source = `
      export function handler(payload: unknown, internalCache: unknown) {
        try {
          const parsed = payload as any;
          const forced = payload as unknown as string;
          const broad = parsed as object;
          return { parsed, forced, broad, internalCache };
        } catch (err: unknown) {
          // @ts-expect-error deliberate marker for the analyzer fixture
          return err.message;
        }
      }
      export const literal = "this text mentions any and @ts-ignore but is a string";
      export function typed(value: any): any { return value; }
    `;

  const { findings } = analyzeTypeSyntax(parse(source), "fixture.ts");
  const counts = summarizeTypeSyntax(findings);

  it("finds every explicit any and ignores string literals", () => {
    expect(counts.explicitAny).toBe(3); // `as any`, and two on `typed`
    expect(findings.every((finding) => finding.detail !== "literal")).toBe(true);
  });

  it("classifies unknown by syntactic position", () => {
    // `payload` and `internalCache` are parameters -> narrowing required;
    // the `catch (err: unknown)` binding is the only boundary-valid case here.
    expect(counts.unknownBoundary).toBe(1);
    expect(counts.unknownNarrowing).toBe(2);
    expect(counts.unknownBoundary + counts.unknownNarrowing + counts.unknownInternal).toBe(4);
  });

  it("finds double assertions and broad casts separately", () => {
    expect(counts.doubleAssertion).toBe(1);
    expect(counts.broadCast).toBe(2); // `as any` and `as object`
  });

  it("finds suppression markers only inside comments", () => {
    expect(counts.suppression).toBe(1);
    const suppression = findings.find((finding) => finding.category === "suppression");
    expect(suppression?.detail).toBe("ts-expect-error");
  });

  it("reports deterministic ordering with file, line and column", () => {
    const ordered = [...findings].sort(
      (left, right) => left.line - right.line || left.column - right.column,
    );
    expect(findings.map((f) => `${f.line}:${f.column}`)).toEqual(
      ordered.map((f) => `${f.line}:${f.column}`),
    );
    expect(new Set(findings.map((f) => f.file))).toEqual(new Set(["fixture.ts"]));
  });

  it("counts a broad cast in both broadCast and explicitAny deliberately", () => {
    // `x as any` contains an `any` keyword *and* is a broad cast. Both are
    // gated, so the overlap only makes the ratchet stricter; the categories are
    // not a partition and must not be summed. Documented in quality-metrics.md.
    const single = analyzeTypeSyntax(parse("const y = z as any;"), "f.ts").findings;
    const cats = single.map((finding) => finding.category).sort();
    expect(cats).toEqual(["broadCast", "explicitAny"]);
  });
});

describe("unknown classification is positional, not name-based", () => {
  const classify = (source: string) =>
    analyzeTypeSyntax(parse(source), "f.ts")
      .findings.filter((finding) => finding.category.startsWith("unknown"))
      .map((finding) => finding.category);

  it("treats a catch binding as boundary-valid", () => {
    expect(
      classify("function f() { try { g(); } catch (e: unknown) { void e; } }"),
    ).toEqual(["unknownBoundary"]);
  });

  it("treats decode-target shapes as boundary-valid", () => {
    expect(classify("type A = Record<string, unknown>;")).toEqual(["unknownBoundary"]);
    expect(classify("type B = unknown[];")).toEqual(["unknownBoundary"]);
    expect(classify("interface C { [key: string]: unknown }")).toEqual(["unknownBoundary"]);
  });

  it("treats parameters as narrowing-required", () => {
    expect(classify("function f(payload: unknown) { return payload; }")).toEqual([
      "unknownNarrowing",
    ]);
  });

  it("does not let a well-chosen identifier name escape the internal category", () => {
    // Regression guard for an audit finding: an earlier name-substring heuristic
    // classified `resultValue`/`cachedResult` as boundary-valid — and because
    // boundary `unknown` is not ratcheted, that let internal imprecision hide
    // from the Phase 7 gate purely by naming.
    expect(classify("const resultValue: unknown = compute();")).toEqual(["unknownInternal"]);
    expect(classify("const cachedResult: unknown = compute();")).toEqual(["unknownInternal"]);
    expect(classify("const payload: unknown = compute();")).toEqual(["unknownInternal"]);
    expect(classify("const internalState: unknown = compute();")).toEqual(["unknownInternal"]);
  });

  it("classifies internal declaration positions as internal", () => {
    expect(classify("class K { private state: unknown = null; }")).toEqual([
      "unknownInternal",
    ]);
    expect(classify("function f(): unknown { return 1; }")).toEqual(["unknownInternal"]);
  });
});

describe("line-count definition and scope", () => {
  it("counts physical lines including blanks and comments", () => {
    expect(countPhysicalLines("a\n\n// comment\nb\n")).toBe(4);
    expect(countPhysicalLines("")).toBe(0);
    expect(countPhysicalLines("single")).toBe(1);
  });

  it("applies the stricter Classic budget", () => {
    expect(lineLimitFor("src/agent/runner.ts")).toBe(LIMITS.fileLines);
    expect(lineLimitFor("src/classic/app.tsx")).toBe(LIMITS.classicFileLines);
    expect(LIMITS.classicFileLines).toBeLessThan(LIMITS.fileLines);
  });

  it("excludes only the two generated modules", () => {
    expect(isGenerated("src/prompts/embedded.ts")).toBe(true);
    expect(isGenerated("src/version.generated.ts")).toBe(true);
    expect(isGenerated("src/agent/runner.ts")).toBe(false);
  });
});
