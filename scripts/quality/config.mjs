/**
 * Quality measurement scope and thresholds (Phase 0, P0-05).
 *
 * This module is the single machine-readable definition consumed by every
 * analyzer in `scripts/quality/`. The prose rationale lives in
 * `refactor/quality-metrics.md`; the two must be changed together.
 *
 * Nothing here may be widened to make a change pass. Ratchets move down only.
 */
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Report schema version. Bump only alongside a reviewed comparator change. */
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Production measurement scope: compiled application source only.
 * Tests, scripts and fixtures are deliberately outside the metric scope; they
 * are governed by review and by the architecture tests.
 */
export const SOURCE_ROOTS = Object.freeze(["src"]);

export const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx"]);

/**
 * Generated outputs. Excluded from every code metric because editing them by
 * hand is forbidden; their generators are the reviewed surface.
 *
 *   src/prompts/embedded.ts  — scripts/embed-prompts.mjs
 *   src/version.generated.ts — scripts/sync-version.mjs
 */
export const GENERATED_FILES = Object.freeze([
  "src/prompts/embedded.ts",
  "src/version.generated.ts",
]);

/**
 * Behavior-bearing files exempt from *line-count* limits only. Their layout is
 * a contract (prompt text, wire fixtures). They remain in scope for every other
 * metric. Empty at the anchor: no `.md` prompt source is a TypeScript module.
 */
export const LINE_LIMIT_EXEMPT_FILES = Object.freeze([]);

/**
 * Files that hold code moved verbatim out of an oversized legacy file. Their
 * metrics are the origin file's legacy metrics at a new path, so the changed
 * gate reports them as relocated instead of new. Each entry must name the
 * origin, and every entry is expected to disappear as the code is decomposed.
 */
export const RELOCATED_LEGACY_FILES = Object.freeze({
  "src/llm/wire/model-catalog.ts": "src/llm/http.ts",
  "src/llm/wire/abort-race.ts": "src/llm/http.ts",
  "src/llm/wire/openai-stream.ts": "src/llm/http.ts",
  "src/llm/wire/stream-framing.ts": "src/llm/http.ts",
  "src/llm/wire/reasoning-payload.ts": "src/llm/http.ts",
  "src/llm/wire/chat-body.ts": "src/llm/http.ts",
  "src/llm/wire/openai-complete.ts": "src/llm/http.ts",
  "src/llm/wire/response-errors.ts": "src/llm/http.ts",
  "src/llm/wire/reasoning-artifacts.ts": "src/llm/http.ts",
  "src/llm/wire/capability-errors.ts": "src/llm/http.ts",
  "src/agent/turn/tool-execution/single-tool.ts": "src/agent/runner.ts",
  "src/agent/turn/loop/run-rounds.ts": "src/agent/runner.ts",
  "src/agent/turn/loop/round-request.ts": "src/agent/runner.ts",
  "src/agent/turn/loop/answer-path.ts": "src/agent/runner.ts",
});

/**
 * Terminal thresholds from refactor/instructions.md §8. `max` values are
 * exclusive upper bounds: a unit must be strictly below the number.
 */
export const LIMITS = Object.freeze({
  /** Ordinary production source files, physical lines. */
  fileLines: 500,
  /** Classic UI source follows the stricter contributor guideline. */
  classicFileLines: 400,
  cyclomatic: 22,
  cognitive: 22,
  halsteadDifficulty: 80,
  crap: 25,
});

/** Paths whose files use the stricter Classic line budget. */
export const CLASSIC_ROOTS = Object.freeze(["src/classic"]);

/** Report output locations, all repository-local (no external upload). */
export const REPORTS = Object.freeze({
  directory: join(ROOT, "refactor", "evidence", "phase-0", "reports"),
  metrics: "metrics.json",
  typeSyntax: "type-syntax.json",
  summary: "summary.md",
  coverage: join(ROOT, "coverage", "coverage-final.json"),
});

/** Committed baselines the ratchet compares against. */
export const BASELINES = Object.freeze({
  directory: join(ROOT, "refactor", "evidence", "phase-0", "baselines"),
  metrics: "metrics-baseline.json",
});

/**
 * Runtime budgets in milliseconds. An analyzer that exceeds its budget is
 * recorded as `measured: false` and treated as a failure, never as a pass.
 */
export const TIMEOUTS = Object.freeze({
  astMetrics: 300_000,
  typeSyntax: 300_000,
  duplication: 600_000,
  deadCode: 600_000,
});

/** Classifies a repository-relative path for line-limit purposes. */
export function lineLimitFor(repoPath) {
  if (CLASSIC_ROOTS.some((root) => repoPath.startsWith(`${root}/`))) {
    return LIMITS.classicFileLines;
  }
  return LIMITS.fileLines;
}

/** True when the path is generated and therefore out of metric scope. */
export function isGenerated(repoPath) {
  return GENERATED_FILES.includes(repoPath);
}
