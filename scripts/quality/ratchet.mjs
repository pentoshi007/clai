/**
 * Monotonic quality ratchet (Phase 0, P0-07).
 *
 * Compares the live report against the committed baseline and fails on any
 * regression:
 *
 *   - a file newly at/over its line limit;
 *   - a function newly at/over a complexity limit;
 *   - a raised maximum for any metric;
 *   - an increased count in any type-syntax category that is treated as debt.
 *
 * Legacy findings recorded in the baseline are *reported* but do not fail, which
 * is what makes the gate usable at the anchor. Values may only move down: the
 * comparator refuses to accept a baseline that grew, so "update the baseline to
 * make it pass" is not an available workflow.
 *
 * Usage:
 *   node scripts/quality/ratchet.mjs                 # compare, exit 1 on regression
 *   node scripts/quality/ratchet.mjs --write-baseline # only when values improved
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINES, ROOT } from "./config.mjs";
import { buildReport, toBaseline } from "./report.mjs";

export const BASELINE_PATH = join(BASELINES.directory, BASELINES.metrics);

/** Type-syntax categories that must never increase. */
export const RATCHETED_TYPE_CATEGORIES = Object.freeze([
  "explicitAny",
  "unknownNarrowing",
  "unknownInternal",
  "doubleAssertion",
  "broadCast",
  "suppression",
]);

/**
 * Compares two baseline-shaped objects.
 *
 * @returns {{ regressions: string[], improvements: string[], held: number }}
 */
export function compareBaselines(baseline, current) {
  const regressions = [];
  const improvements = [];
  let held = 0;

  const stableFunctionIdentity = (entry) => entry.replace(/@\d+$/, "");

  const compareSets = (label, before, after, identity = (entry) => entry) => {
    const grouped = (entries) => {
      const groups = new Map();
      for (const entry of entries) {
        const key = identity(entry);
        const group = groups.get(key) ?? [];
        group.push(entry);
        groups.set(key, group);
      }
      return groups;
    };
    const beforeGroups = grouped(before);
    const afterGroups = grouped(after);
    const keys = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);
    for (const key of keys) {
      const previous = beforeGroups.get(key) ?? [];
      const current = afterGroups.get(key) ?? [];
      held += Math.min(previous.length, current.length);
      for (const entry of current.slice(previous.length)) {
        regressions.push(`new ${label}: ${entry}`);
      }
      for (const entry of previous.slice(current.length)) {
        improvements.push(`resolved ${label}: ${entry}`);
      }
    }
  };

  compareSets("file over line limit", baseline.filesOverLineLimit, current.filesOverLineLimit);
  compareSets(
    "cyclomatic violation",
    baseline.functionsOverCyclomatic,
    current.functionsOverCyclomatic,
    stableFunctionIdentity,
  );
  compareSets(
    "cognitive violation",
    baseline.functionsOverCognitive,
    current.functionsOverCognitive,
    stableFunctionIdentity,
  );
  compareSets(
    "Halstead violation",
    baseline.functionsOverHalstead,
    current.functionsOverHalstead,
    stableFunctionIdentity,
  );

  for (const [metric, limit] of Object.entries(baseline.maxima)) {
    const now = current.maxima[metric];
    if (typeof now !== "number") {
      regressions.push(`missing maximum for ${metric}`);
      continue;
    }
    if (now > limit) {
      regressions.push(`raised maximum ${metric}: ${limit} -> ${now}`);
    } else if (now < limit) {
      improvements.push(`lowered maximum ${metric}: ${limit} -> ${now}`);
    }
  }

  for (const category of RATCHETED_TYPE_CATEGORIES) {
    const before = baseline.typeSyntax?.[category] ?? 0;
    const after = current.typeSyntax?.[category] ?? 0;
    if (after > before) {
      regressions.push(`increased ${category}: ${before} -> ${after}`);
    } else if (after < before) {
      improvements.push(`reduced ${category}: ${before} -> ${after}`);
    }
  }

  // Tightening a limit is allowed; loosening one is not.
  for (const [name, limit] of Object.entries(baseline.limits)) {
    const now = current.limits[name];
    if (typeof now !== "number") {
      regressions.push(`missing limit ${name}`);
      continue;
    }
    if (now > limit) regressions.push(`loosened limit ${name}: ${limit} -> ${now}`);
  }

  return {
    regressions: regressions.sort(),
    improvements: improvements.sort(),
    held,
  };
}

export function readBaselineFile() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function main() {
  const report = buildReport();
  if (!report.measured) {
    process.stderr.write("quality:ratchet: analyzer exceeded its runtime budget — not green\n");
    process.exit(1);
  }
  const current = toBaseline(report);

  if (process.argv.includes("--init")) {
    if (existsSync(BASELINE_PATH)) {
      process.stderr.write(
        "quality:ratchet: --init refuses to overwrite an existing baseline; use --write-baseline to ratchet down\n",
      );
      process.exit(1);
    }
    mkdirSync(BASELINES.directory, { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(
      `quality:ratchet: initialized ${relative(ROOT, BASELINE_PATH)} from the current anchor — commit it\n`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    // Never silently create a baseline here. On a fresh checkout that would
    // adopt whatever state the working tree is in — including a regression —
    // and exit 0, making the CI gate incapable of failing. Creating a baseline
    // is an explicit, reviewed action.
    process.stderr.write(
      [
        `quality:ratchet: missing baseline ${relative(ROOT, BASELINE_PATH)}`,
        "The baseline must be committed for this gate to mean anything.",
        "Create it deliberately from a green anchor with:",
        "  node scripts/quality/ratchet.mjs --init",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const baseline = readBaselineFile();
  const { regressions, improvements, held } = compareBaselines(baseline, current);

  for (const line of improvements) process.stdout.write(`improvement: ${line}\n`);
  process.stdout.write(
    `quality:ratchet: ${held} legacy finding(s) held, ${improvements.length} improvement(s), ${regressions.length} regression(s)\n`,
  );

  if (regressions.length > 0) {
    process.stderr.write(`${regressions.map((line) => `regression: ${line}`).join("\n")}\n`);
    process.stderr.write(
      "quality:ratchet: fix or revert the regression. Baselines may only decrease.\n",
    );
    process.exit(1);
  }

  if (process.argv.includes("--write-baseline")) {
    if (improvements.length === 0) {
      process.stdout.write("quality:ratchet: baseline already minimal; nothing to write\n");
      return;
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(
      `quality:ratchet: ratcheted ${relative(ROOT, BASELINE_PATH)} down\n`,
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) main();
