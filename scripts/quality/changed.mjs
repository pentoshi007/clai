import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { LIMITS, ROOT } from "./config.mjs";
import { buildReport } from "./report.mjs";

const METRICS_PATH = "refactor/evidence/phase-0/reports/metrics.json";
const GATED_TYPE_CATEGORIES = new Set([
  "explicitAny",
  "unknownNarrowing",
  "unknownInternal",
  "doubleAssertion",
  "broadCast",
  "suppression",
]);

export function parseNameStatus(output) {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const entries = [];
  for (let index = 0; index < parts.length; ) {
    const rawStatus = parts[index++];
    if (!rawStatus) continue;
    const status = rawStatus[0];
    if (status === "R" || status === "C") {
      const previousPath = parts[index++];
      const path = parts[index++];
      if (path) entries.push({ status, path, previousPath });
      continue;
    }
    const path = parts[index++];
    if (path) entries.push({ status, path });
  }
  return entries;
}

export function parseAddedLines(diff) {
  const lines = new Set();
  let currentLine;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (currentLine === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.add(currentLine);
      currentLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) continue;
    currentLine += 1;
  }
  return lines;
}

export function includeUntrackedChanges(entries, output) {
  const paths = output.split("\0").filter(Boolean);
  const known = new Set(entries.map((entry) => entry.path));
  return [
    ...entries,
    ...paths
      .filter((path) => !known.has(path))
      .map((path) => ({ status: "A", path })),
  ];
}

function functionGroups(functions, file) {
  const groups = new Map();
  for (const fn of functions.filter((entry) => entry.file === file)) {
    const group = groups.get(fn.name) ?? [];
    group.push(fn);
    groups.set(fn.name, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.line - right.line);
  return groups;
}

function intersectsAddedLine(fn, addedLines) {
  if (typeof fn.endLine !== "number") {
    throw new Error(`quality:changed: missing endLine for ${fn.file}#${fn.name}@${fn.line}`);
  }
  for (const line of addedLines) {
    if (line >= fn.line && line <= fn.endLine) return true;
  }
  return false;
}

function baselineFunction(fn, currentGroups, baselineGroups) {
  const current = currentGroups.get(fn.name) ?? [];
  const baseline = baselineGroups.get(fn.name) ?? [];
  const index = current.indexOf(fn);
  return index >= 0 ? baseline[index] : undefined;
}

function metricFailures(file, fn, baseline) {
  const failures = [];
  for (const [key, limit, label] of [
    ["cyclomatic", LIMITS.cyclomatic, "cyclomatic"],
    ["cognitive", LIMITS.cognitive, "cognitive"],
    ["halsteadDifficulty", LIMITS.halsteadDifficulty, "Halstead difficulty"],
  ]) {
    const value = fn[key];
    if (value < limit) continue;
    const prior = baseline?.[key];
    if (typeof prior === "number" && prior >= limit && value <= prior) continue;
    failures.push(`${file}#${fn.name}@${fn.line}: ${label} ${value} must be < ${limit}`);
  }
  return failures;
}

export function evaluateChangedQuality({ current, baseline, changes }) {
  const failures = [];
  const held = [];
  for (const change of changes) {
    const file = change.path;
    const currentFile = current.files.find((entry) => entry.file === file);
    if (!currentFile) continue;
    const baselineFile = baseline.files.find((entry) => entry.file === file);
    if (currentFile.lines >= currentFile.limit) {
      if (
        baselineFile &&
        baselineFile.lines >= baselineFile.limit &&
        currentFile.lines <= baselineFile.lines
      ) {
        held.push(`${file}: line count ${currentFile.lines} held from ${baselineFile.lines}`);
      } else {
        failures.push(`${file}: ${currentFile.lines} lines must be < ${currentFile.limit}`);
      }
    }

    const currentGroups = functionGroups(current.functions, file);
    const baselineGroups = functionGroups(baseline.functions, file);
    for (const fn of current.functions.filter((entry) => entry.file === file)) {
      if (change.status !== "A" && !intersectsAddedLine(fn, change.addedLines)) continue;
      const prior = baselineFunction(fn, currentGroups, baselineGroups);
      const metricProblems = metricFailures(file, fn, prior);
      if (metricProblems.length > 0) failures.push(...metricProblems);
      else if (
        fn.cyclomatic >= LIMITS.cyclomatic ||
        fn.cognitive >= LIMITS.cognitive ||
        fn.halsteadDifficulty >= LIMITS.halsteadDifficulty
      ) {
        held.push(`${file}#${fn.name}@${fn.line}: legacy complexity held or improved`);
      }
    }

    for (const finding of current.typeSyntaxFindings.filter(
      (entry) =>
        entry.file === file &&
        GATED_TYPE_CATEGORIES.has(entry.category) &&
        (change.status === "A" || change.addedLines.has(entry.line)),
    )) {
      failures.push(
        `${file}:${finding.line}:${finding.column}: new ${finding.category} (${finding.detail})`,
      );
    }
  }
  return { failures, held };
}

function gitOutput(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function changedEntries(base) {
  const tracked = parseNameStatus(
    gitOutput(["diff", "--name-status", "-z", "--diff-filter=ACMR", base, "--", "src"]),
  );
  const entries = includeUntrackedChanges(
    tracked,
    gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--", "src"]),
  );
  return entries.map((entry) => ({
    ...entry,
    addedLines:
      entry.status === "A"
        ? new Set()
        : parseAddedLines(
            gitOutput(["diff", "--unified=0", "--no-color", base, "--", entry.path]),
          ),
  }));
}

function readBaseline(base) {
  return JSON.parse(gitOutput(["show", `${base}:${METRICS_PATH}`]));
}

function requestedBase() {
  const index = process.argv.indexOf("--base");
  if (index < 0) return "HEAD";
  const value = process.argv[index + 1];
  if (!value) throw new Error("quality:changed: --base requires a git revision");
  return value;
}

function main() {
  const base = requestedBase();
  const changes = changedEntries(base);
  if (changes.length === 0) {
    process.stdout.write("quality:changed: no changed production files\n");
    return;
  }
  const current = buildReport({ includeFunctionRanges: true });
  const baseline = readBaseline(base);
  const result = evaluateChangedQuality({ current, baseline, changes });
  for (const line of result.held) process.stdout.write(`held: ${line}\n`);
  for (const line of result.failures) process.stderr.write(`failure: ${line}\n`);
  process.stdout.write(
    `quality:changed: ${changes.length} file(s), ${result.held.length} held, ${result.failures.length} failure(s)\n`,
  );
  if (result.failures.length > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) main();
