import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: Math.min(4, availableParallelism()),
    // Nested agent worktrees are ignored project artifacts, not part of this
    // checkout's test matrix. Without this exclusion Vitest discovers stale
    // copies with independently generated version metadata.
    //
    // `.stryker-tmp` holds Stryker's sandbox copies of the whole repository
    // during a mutation run (and can survive an aborted one). Without the
    // exclusion, `npm run test:arch` reported 4 files / 20 tests instead of
    // 1 / 5 because it also ran the sandboxed duplicates.
    exclude: [...configDefaults.exclude, "**/.kiro/**", "**/.stryker-tmp/**"],
    // Seed isolated, writable clai storage roots for every test file before
    // its modules load, so no test writes to (or races on) the developer's
    // real home-directory config/data. See test/vitest.setup.ts and Phase 0
    // requirement V2-002.
    setupFiles: ["./test/vitest.setup.ts"],
    // Coverage is opt-in (`--coverage`, i.e. `npm run quality:coverage`) so the
    // default suite keeps its recorded runtime. The provider is pinned to the
    // Vitest version in package.json; the scope mirrors
    // scripts/quality/config.mjs so CRAP joins metrics and coverage over the
    // same file set.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/prompts/embedded.ts", "src/version.generated.ts"],
      all: true,
    },
  },
});
