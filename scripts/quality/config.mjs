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
  "src/ui-core/commands/pickers/custom-provider.ts": "src/ui-core/commands/picker-commands.ts",
  "src/ui-core/commands/pickers/history.ts": "src/ui-core/commands/picker-commands.ts",
  "src/ui-core/commands/pickers/models.ts": "src/ui-core/commands/picker-commands.ts",
  "src/ui-core/commands/pickers/provider.ts": "src/ui-core/commands/picker-commands.ts",
  "src/ui-core/rendering/syntax/keywords.ts": "src/ui-core/rendering/syntax-highlight.ts",
  "src/ui-core/rendering/syntax/language-highlighters.ts": "src/ui-core/rendering/syntax-highlight.ts",
  "src/ui-core/rendering/syntax/language-table.ts": "src/ui-core/rendering/syntax-highlight.ts",
  "src/ui-core/rendering/markdown/tables.ts": "src/ui-core/rendering/markdown.ts",
  "src/tools/web/search-attempts.ts": "src/tools/web/search.ts",
  "src/agent/context/compact-with-summary.ts": "src/agent/context-manager.ts",
  "src/tools/http/agents.ts": "src/tools/http.ts",
  "src/tools/http/evidence-format.ts": "src/tools/http.ts",
  "src/tools/http/fetch.ts": "src/tools/http.ts",
  "src/agent/plan/actions/plan-clear.ts": "src/agent/plan-tool.ts",
  "src/agent/plan/actions/plan-create.ts": "src/agent/plan-tool.ts",
  "src/agent/plan/actions/task-add.ts": "src/agent/plan-tool.ts",
  "src/agent/plan/actions/task-move.ts": "src/agent/plan-tool.ts",
  "src/agent/plan/normalization.ts": "src/agent/plan-tool.ts",
  "src/safety/shell-classification.ts": "src/safety/classifier.ts",
  "src/safety/tool-classification.ts": "src/safety/classifier.ts",
  "src/tools/web/request-loop.ts": "src/tools/web/fetch-core.ts",
  "src/tools/web/validate-args.ts": "src/tools/web/fetch-core.ts",
  "src/tools/web/response-body.ts": "src/tools/web/fetch-core.ts",
  "src/agent/evidence/task-classification.ts": "src/agent/task-evidence.ts",
  "src/agent/evidence/task-selection.ts": "src/agent/task-evidence.ts",
  "src/agent/evidence/tool-budgets.ts": "src/agent/task-evidence.ts",
  "src/agent/plan/context-message.ts": "src/agent/plan-tool.ts",
  "src/agent/plan/handle-plan-tool.ts": "src/agent/plan-tool.ts",
  "src/agent/parser/arg-formatting.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/bare-recognition.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/parse-entry.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/repetition.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/salvage.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/vendor-protocols.ts": "src/agent/tool-call-parser.ts",
  "src/agent/parser/xml-protocol.ts": "src/agent/tool-call-parser.ts",
  "src/store/config/endpoints.ts": "src/store/config.ts",
  "src/store/config/settings.ts": "src/store/config.ts",
  "src/store/keys/search-providers.ts": "src/store/keys.ts",
  "src/store/keys/secret-store.ts": "src/store/keys.ts",
  "src/store/plan/jsonl-backend.ts": "src/store/plan.ts",
  "src/store/plan/mutation.ts": "src/store/plan.ts",
  "src/store/plan/sqlite-backend.ts": "src/store/plan.ts",
  "src/store/plan/task-normalization.ts": "src/store/plan.ts",
  "src/store/history/jsonl-backend.ts": "src/store/history.ts",
  "src/store/history/jsonl-lock.ts": "src/store/history.ts",
  "src/store/history/lifecycle.ts": "src/store/history.ts",
  "src/store/history/recovery.ts": "src/store/history.ts",
  "src/store/history/session-queries.ts": "src/store/history.ts",
  "src/store/history/sqlite-backend.ts": "src/store/history.ts",
  "src/tools/jobs/helpers.ts": "src/tools/jobs.ts",
  "src/tools/jobs/limits.ts": "src/tools/jobs.ts",
  "src/tools/jobs/polling-policy.ts": "src/tools/jobs.ts",
  "src/tools/jobs/process-identity.ts": "src/tools/jobs.ts",
  "src/tools/jobs/redacted-writer.ts": "src/tools/jobs.ts",
  "src/tools/jobs/types.ts": "src/tools/jobs.ts",
  "src/tools/shell/capture.ts": "src/tools/shell.ts",
  "src/tools/shell/exec-attempt.ts": "src/tools/shell.ts",
  "src/tools/shell/spawn-argv.ts": "src/tools/shell.ts",
  "src/tools/fs/mutations.ts": "src/tools/fs.ts",
  "src/tools/fs/read.ts": "src/tools/fs.ts",
  "src/tools/fs/read-window.ts": "src/tools/fs.ts",
  "src/tools/fs/search.ts": "src/tools/fs.ts",
  "src/tools/batch/run-batch.ts": "src/tools/registry.ts",
  "src/tools/call-normalization.ts": "src/tools/registry.ts",
  "src/tools/handlers/args.ts": "src/tools/registry.ts",
  "src/tools/handlers/context-1.ts": "src/tools/registry.ts",
  "src/tools/handlers/context-2.ts": "src/tools/registry.ts",
  "src/tools/handlers/files-1.ts": "src/tools/registry.ts",
  "src/tools/handlers/files-2.ts": "src/tools/registry.ts",
  "src/tools/handlers/network-1.ts": "src/tools/registry.ts",
  "src/tools/handlers/network-2.ts": "src/tools/registry.ts",
  "src/tools/handlers/network-3.ts": "src/tools/registry.ts",
  "src/tools/handlers/nmap-preparation.ts": "src/tools/registry.ts",
  "src/tools/handlers/orchestration-1.ts": "src/tools/registry.ts",
  "src/tools/handlers/orchestration-2.ts": "src/tools/registry.ts",
  "src/tools/handlers/pentest.ts": "src/tools/registry.ts",
  "src/tools/handlers/shell-1.ts": "src/tools/registry.ts",
  "src/tools/handlers/shell-2.ts": "src/tools/registry.ts",
  "src/tools/handlers/shell-3.ts": "src/tools/registry.ts",
  "src/tools/handlers/web.ts": "src/tools/registry.ts",
  "src/llm/tool-wire/argument-repair.ts": "src/llm/tool-protocol.ts",
  "src/llm/responses/item-events.ts": "src/llm/responses-stream-events.ts",
  "src/llm/model-layers/model-rules.ts": "src/llm/provider-model-layers.ts",
  "src/llm/model-layers/nvidia-layer.ts": "src/llm/provider-model-layers.ts",
  "src/llm/model-layers/model-patterns.ts": "src/llm/provider-model-layers.ts",
  "src/llm/usage/provider-parsers.ts": "src/llm/token-usage.ts",
  "src/llm/adapters/anthropic-stream-events.ts": "src/llm/adapters/anthropic-tools.ts",
  "src/llm/adapters/anthropic-wire-blocks.ts": "src/llm/adapters/anthropic-tools.ts",
  "src/llm/artifacts/legacy-blocks.ts": "src/llm/reasoning-artifacts.ts",
  "src/llm/artifacts/replay-selection.ts": "src/llm/reasoning-artifacts.ts",
  "src/llm/profile/layer-merge.ts": "src/llm/provider-profile.ts",
  "src/llm/profile/control-rejections.ts": "src/llm/provider-profile.ts",
  "src/llm/provider-info-text.ts": "src/llm/provider.ts",
  "src/llm/provider-identity.ts": "src/llm/provider.ts",
  "src/llm/profile/spec-validation.ts": "src/llm/custom-provider-profile.ts",
  "src/llm/profile/spec-vocabulary.ts": "src/llm/custom-provider-profile.ts",
  "src/llm/profile/custom-layer.ts": "src/llm/custom-provider-profile.ts",
  "src/llm/capability/state.ts": "src/llm/capabilities.ts",
  "src/llm/capability/vision-registry.ts": "src/llm/capabilities.ts",
  "src/llm/capability/vision-patterns.ts": "src/llm/capabilities.ts",
  "src/llm/capability/tool-dialect.ts": "src/llm/capabilities.ts",
  "src/llm/routing/attempt-stream.ts": "src/llm/router.ts",
  "src/llm/routing/attempt-complete.ts": "src/llm/router.ts",
  "src/llm/routing/key-rotation.ts": "src/llm/router.ts",
  "src/llm/routing/failure-report.ts": "src/llm/router.ts",
  "src/llm/routing/error-classification.ts": "src/llm/router.ts",
  "src/llm/routing/attempt-request.ts": "src/llm/router.ts",
  "src/llm/routing/provider-selection.ts": "src/llm/router.ts",
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
