import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

/**
 * Vitest configuration used only by Stryker mutation runs (Phase 0, P0-04).
 *
 * Two constraints shape this file:
 *
 * 1. Stryker's Vitest runner executes tests in worker threads and does not honor
 *    a `pool` override. Two suites in this repository call `process.chdir()`,
 *    which Node forbids in worker threads, so an unbounded dry run always fails
 *    with `process.chdir() is not supported in workers` before any mutant is
 *    evaluated. That is a runner/environment limitation, not a product defect —
 *    the same suites pass in the normal fork-based run.
 *
 * 2. Mutation must be bounded by module during the refactor phases; a
 *    repository-wide run is a Phase 8 scheduled job, not a per-seam gate.
 *
 * Both are handled by narrowing the test scope. Set `CLAI_MUTATION_TESTS` to a
 * comma-separated list of globs covering the mutated module:
 *
 *   CLAI_MUTATION_TESTS='test/thinking.test.ts' \
 *     npm run quality:mutation -- --mutate 'src/llm/reasoning-marker.ts'
 *
 * Leaving it unset selects the recorded default scope for the pinned spike.
 */
const DEFAULT_MUTATION_TESTS = [
  "test/thinking.test.ts",
  "test/agent/typed-stream-events.test.ts",
];

const include = (process.env.CLAI_MUTATION_TESTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: include.length > 0 ? include : DEFAULT_MUTATION_TESTS,
      coverage: { enabled: false },
    },
  }),
);
