import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: Math.min(4, availableParallelism()),
    // Nested agent worktrees are ignored project artifacts, not part of this
    // checkout's test matrix. Without this exclusion Vitest discovers stale
    // copies with independently generated version metadata.
    //
    exclude: [...configDefaults.exclude, "**/.kiro/**"],
    // Seed isolated, writable clai storage roots for every test file before
    // its modules load, so no test writes to (or races on) the developer's
    // real home-directory config/data. See test/vitest.setup.ts.
    setupFiles: ["./test/vitest.setup.ts"],
    // Coverage is opt-in (`--coverage`) so the default suite keeps its
    // recorded runtime. The provider is pinned to the Vitest version in
    // package.json.
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
