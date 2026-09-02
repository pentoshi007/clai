/**
 * Quality report generator (Phase 0, P0-04/P0-05/P0-06).
 *
 * Produces one deterministic, machine-readable report plus a concise human
 * summary from repository-owned analyzers:
 *
 *   - physical line counts per production source file;
 *   - per-function cyclomatic, cognitive and Halstead metrics;
 *   - CRAP when a V8/Istanbul coverage report is present;
 *   - the type-syntax classification.
 *
 * External analyzers (knip, jscpd, Stryker) are pinned and invoked by their own
 * npm scripts so an unstable tool can be reverted independently; their presence
 * and version are recorded here.
 *
 * Everything runs locally. No source, report or fixture is transmitted anywhere.
 *
 * Usage:
 *   node scripts/quality/report.mjs             # write reports
 *   node scripts/quality/report.mjs --stdout    # print JSON, write nothing
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  BASELINES,
  isGenerated,
  LIMITS,
  LINE_LIMIT_EXEMPT_FILES,
  lineLimitFor,
  REPORTS,
  REPORT_SCHEMA_VERSION,
  ROOT,
  SOURCE_EXTENSIONS,
  SOURCE_ROOTS,
  TIMEOUTS,
} from "./config.mjs";
import { crapScore, measureFunctions } from "./ast-metrics.mjs";
import { analyzeTypeSyntax, summarizeTypeSyntax } from "./type-syntax.mjs";

const require = createRequire(import.meta.url);

/** Recursively lists in-scope production source files, sorted. */
export function listSourceFiles() {
  const { readdirSync } = require("node:fs");
  const out = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const full = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(relative(ROOT, full).split("\\").join("/"));
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  return out.filter((file) => !isGenerated(file)).sort();
}

/** Physical line count: newline-separated lines, ignoring a trailing newline. */
export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Reads Istanbul-shaped coverage produced by @vitest/coverage-v8, if present. */
function readCoverage() {
  if (!existsSync(REPORTS.coverage)) return null;
  try {
    return JSON.parse(readFileSync(REPORTS.coverage, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Maps coverage function hit data onto measured functions by start line.
 * Returns null when coverage is unavailable so CRAP is reported as unmeasured
 * rather than silently assumed to be 100%.
 */
function coverageIndex(coverage) {
  if (!coverage) return null;
  const byFile = new Map();
  for (const [absolute, entry] of Object.entries(coverage)) {
    const repoPath = relative(ROOT, absolute).split("\\").join("/");
    const lineHits = new Map();
    const statementMap = entry.statementMap ?? {};
    const statements = entry.s ?? {};
    for (const [id, location] of Object.entries(statementMap)) {
      const line = location?.start?.line;
      if (typeof line !== "number") continue;
      const hits = statements[id] ?? 0;
      lineHits.set(line, (lineHits.get(line) ?? 0) + hits);
    }
    byFile.set(repoPath, { lineHits, functions: entry.fnMap ?? {}, fnHits: entry.f ?? {} });
  }
  return byFile;
}

/** Fraction of a function's statement lines that were executed. */
function coverageForFunction(fileCoverage, fn) {
  if (!fileCoverage) return null;
  let total = 0;
  let covered = 0;
  for (const [line, hits] of fileCoverage.lineHits) {
    if (line < fn.line || line > fn.endLine) continue;
    total += 1;
    if (hits > 0) covered += 1;
  }
  if (total === 0) return null;
  return covered / total;
}

function toolVersion(packageName) {
  // Read the manifest from disk: several of these packages restrict `exports`,
  // so `require("<pkg>/package.json")` is not resolvable for all of them.
  try {
    const manifest = join(ROOT, "node_modules", ...packageName.split("/"), "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** Builds the full report object. */
export function buildReport(options = {}) {
  const includeFunctionRanges = options.includeFunctionRanges === true;
  const startedAt = Date.now();
  const files = listSourceFiles();
  const coverage = coverageIndex(readCoverage());

  const fileReports = [];
  const functionReports = [];
  const typeFindings = [];

  for (const file of files) {
    const absolute = join(ROOT, file);
    const text = readFileSync(absolute, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const lines = countPhysicalLines(text);
    const limit = lineLimitFor(file);
    fileReports.push({
      file,
      lines,
      limit,
      exempt: LINE_LIMIT_EXEMPT_FILES.includes(file),
      overLimit: !LINE_LIMIT_EXEMPT_FILES.includes(file) && lines >= limit,
    });

    const fileCoverage = coverage ? coverage.get(file) ?? null : null;
    for (const fn of measureFunctions(sourceFile)) {
      const cov = coverageForFunction(fileCoverage, fn);
      const functionReport = {
        file,
        name: fn.name,
        line: fn.line,
        cyclomatic: fn.cyclomatic,
        cognitive: fn.cognitive,
        halsteadDifficulty: fn.halstead.difficulty,
        halsteadVolume: fn.halstead.volume,
        coverage: cov === null ? null : Math.round(cov * 10000) / 10000,
        crap: cov === null ? null : crapScore(fn.cyclomatic, cov),
      };
      if (includeFunctionRanges) functionReport.endLine = fn.endLine;
      functionReports.push(functionReport);
    }

    typeFindings.push(...analyzeTypeSyntax(sourceFile, file).findings);
  }

  functionReports.sort(
    (left, right) =>
      left.file.localeCompare(right.file, "en-US") ||
      left.line - right.line ||
      left.name.localeCompare(right.name, "en-US"),
  );
  typeFindings.sort(
    (left, right) =>
      left.file.localeCompare(right.file, "en-US") ||
      left.line - right.line ||
      left.column - right.column ||
      left.category.localeCompare(right.category, "en-US"),
  );

  const durationMs = Date.now() - startedAt;
  const measured = durationMs <= TIMEOUTS.astMetrics;

  // Partial coverage (a single test file) still produces a valid join, but CRAP
  // is only meaningful against a full-suite run. Record the observed ratio so a
  // reader can tell the two apart instead of reading 0% as real risk.
  let coveredLines = 0;
  let totalLines = 0;
  if (coverage) {
    for (const entry of coverage.values()) {
      for (const hits of entry.lineHits.values()) {
        totalLines += 1;
        if (hits > 0) coveredLines += 1;
      }
    }
  }
  const coverageLineRatio =
    coverage && totalLines > 0 ? Math.round((coveredLines / totalLines) * 10000) / 10000 : null;

  const overLimitFiles = fileReports.filter((entry) => entry.overLimit);
  const exceeds = (key, limit) =>
    functionReports.filter((fn) => fn[key] !== null && fn[key] >= limit);

  const typeCounts = summarizeTypeSyntax(typeFindings);

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedBy: "scripts/quality/report.mjs",
    measured,
    durationMs,
    limits: LIMITS,
    tools: {
      typescript: ts.version,
      vitest: toolVersion("vitest"),
      coverageV8: toolVersion("@vitest/coverage-v8"),
      knip: toolVersion("knip"),
      jscpd: toolVersion("jscpd"),
      stryker: toolVersion("@stryker-mutator/core"),
    },
    scope: {
      roots: [...SOURCE_ROOTS],
      fileCount: files.length,
      functionCount: functionReports.length,
      coverageAvailable: coverage !== null,
      coverageLineRatio,
      // CRAP is only a valid gate when coverage came from the complete suite.
      crapMeasured: coverageLineRatio !== null && coverageLineRatio >= 0.5,
    },
    totals: {
      filesOverLineLimit: overLimitFiles.length,
      maxFileLines: fileReports.reduce((max, entry) => Math.max(max, entry.lines), 0),
      cyclomaticOverLimit: exceeds("cyclomatic", LIMITS.cyclomatic).length,
      cognitiveOverLimit: exceeds("cognitive", LIMITS.cognitive).length,
      halsteadOverLimit: exceeds("halsteadDifficulty", LIMITS.halsteadDifficulty).length,
      crapOverLimit: exceeds("crap", LIMITS.crap).length,
      maxCyclomatic: functionReports.reduce((max, fn) => Math.max(max, fn.cyclomatic), 0),
      maxCognitive: functionReports.reduce((max, fn) => Math.max(max, fn.cognitive), 0),
      maxHalsteadDifficulty: functionReports.reduce(
        (max, fn) => Math.max(max, fn.halsteadDifficulty),
        0,
      ),
      typeSyntax: typeCounts,
    },
    files: fileReports.sort((left, right) => left.file.localeCompare(right.file, "en-US")),
    functions: functionReports,
    typeSyntaxFindings: typeFindings,
  };
}

/** Renders the concise human summary written next to the JSON report. */
export function renderSummary(report) {
  const worst = (key, count) =>
    [...report.functions]
      .filter((fn) => fn[key] !== null)
      .sort((left, right) => right[key] - left[key])
      .slice(0, count)
      .map((fn) => `| \`${fn.file}\` | \`${fn.name}\` | ${fn.line} | ${fn[key]} |`)
      .join("\n");

  const oversized = report.files
    .filter((entry) => entry.overLimit)
    .sort((left, right) => right.lines - left.lines)
    .map((entry) => `| \`${entry.file}\` | ${entry.lines} | ${entry.limit} |`)
    .join("\n");

  const t = report.totals;
  return `# Quality report summary

Generated by \`scripts/quality/report.mjs\` — regenerate with \`npm run quality:report\`.

- measured: ${report.measured}
- duration: ${report.durationMs} ms
- files in scope: ${report.scope.fileCount}
- functions measured: ${report.scope.functionCount}
- coverage data available: ${report.scope.coverageAvailable}
- coverage line ratio: ${report.scope.coverageLineRatio === null ? "unmeasured" : report.scope.coverageLineRatio}
- CRAP measured (full-suite coverage): ${report.scope.crapMeasured}
- TypeScript ${report.tools.typescript} · Vitest ${report.tools.vitest} · coverage-v8 ${report.tools.coverageV8} · knip ${report.tools.knip} · jscpd ${report.tools.jscpd} · Stryker ${report.tools.stryker}

## Totals against terminal limits

| Metric | Limit (exclusive) | Over limit | Max observed |
|---|---|---|---|
| file physical lines | ${report.limits.fileLines} (Classic ${report.limits.classicFileLines}) | ${t.filesOverLineLimit} | ${t.maxFileLines} |
| cyclomatic | ${report.limits.cyclomatic} | ${t.cyclomaticOverLimit} | ${t.maxCyclomatic} |
| cognitive | ${report.limits.cognitive} | ${t.cognitiveOverLimit} | ${t.maxCognitive} |
| Halstead difficulty | ${report.limits.halsteadDifficulty} | ${t.halsteadOverLimit} | ${t.maxHalsteadDifficulty} |
| CRAP | ${report.limits.crap} | ${t.crapOverLimit} | ${report.scope.coverageAvailable ? "see report" : "unmeasured"} |

## Type syntax classification

| Category | Count |
|---|---|
| explicit \`any\` | ${t.typeSyntax.explicitAny} |
| \`unknown\` (boundary-valid) | ${t.typeSyntax.unknownBoundary} |
| \`unknown\` (narrowing required) | ${t.typeSyntax.unknownNarrowing} |
| \`unknown\` (internal imprecision) | ${t.typeSyntax.unknownInternal} |
| double assertions | ${t.typeSyntax.doubleAssertion} |
| broad casts | ${t.typeSyntax.broadCast} |
| suppressions | ${t.typeSyntax.suppression} |

## Files at or above the line limit (${t.filesOverLineLimit})

| File | Lines | Limit |
|---|---|---|
${oversized || "| _none_ | | |"}

## Highest cyclomatic complexity

| File | Function | Line | Cyclomatic |
|---|---|---|---|
${worst("cyclomatic", 10)}

## Highest cognitive complexity

| File | Function | Line | Cognitive |
|---|---|---|---|
${worst("cognitive", 10)}

## Highest Halstead difficulty

| File | Function | Line | Difficulty |
|---|---|---|---|
${worst("halsteadDifficulty", 10)}
`;
}

function main() {
  const report = buildReport();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  mkdirSync(REPORTS.directory, { recursive: true });
  writeFileSync(
    join(REPORTS.directory, REPORTS.metrics),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    join(REPORTS.directory, REPORTS.typeSyntax),
    `${JSON.stringify(
      {
        schemaVersion: report.schemaVersion,
        counts: report.totals.typeSyntax,
        findings: report.typeSyntaxFindings,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(REPORTS.directory, REPORTS.summary), renderSummary(report));

  if (process.argv.includes("--write-baseline")) {
    mkdirSync(BASELINES.directory, { recursive: true });
    writeFileSync(
      join(BASELINES.directory, BASELINES.metrics),
      `${JSON.stringify(toBaseline(report), null, 2)}\n`,
    );
  }

  process.stdout.write(
    [
      `quality:report measured=${report.measured} files=${report.scope.fileCount}`,
      `functions=${report.scope.functionCount}`,
      `overLine=${report.totals.filesOverLineLimit}`,
      `cyclomatic>=${LIMITS.cyclomatic}:${report.totals.cyclomaticOverLimit}`,
      `cognitive>=${LIMITS.cognitive}:${report.totals.cognitiveOverLimit}`,
      `halstead>=${LIMITS.halsteadDifficulty}:${report.totals.halsteadOverLimit}`,
      `any=${report.totals.typeSyntax.explicitAny}`,
      `\nreports: ${relative(ROOT, REPORTS.directory)}\n`,
    ].join(" "),
  );

  if (!report.measured) process.exit(1);
}

/**
 * Reduces a full report to the ratchet baseline: sorted violation identities and
 * maxima only. Counts may fall, never rise.
 */
export function toBaseline(report) {
  const overLimit = (key, limit) =>
    report.functions
      .filter((fn) => fn[key] !== null && fn[key] >= limit)
      .map((fn) => `${fn.file}#${fn.name}@${fn.line}`)
      .sort();

  return {
    schemaVersion: report.schemaVersion,
    limits: report.limits,
    filesOverLineLimit: report.files
      .filter((entry) => entry.overLimit)
      .map((entry) => entry.file)
      .sort(),
    maxima: {
      fileLines: report.totals.maxFileLines,
      cyclomatic: report.totals.maxCyclomatic,
      cognitive: report.totals.maxCognitive,
      halsteadDifficulty: report.totals.maxHalsteadDifficulty,
    },
    functionsOverCyclomatic: overLimit("cyclomatic", report.limits.cyclomatic),
    functionsOverCognitive: overLimit("cognitive", report.limits.cognitive),
    functionsOverHalstead: overLimit("halsteadDifficulty", report.limits.halsteadDifficulty),
    typeSyntax: report.totals.typeSyntax,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) main();
