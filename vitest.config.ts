import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: Math.min(4, availableParallelism()),
    // Nested agent worktrees are ignored project artifacts, not part of this
    // checkout's test matrix. Without this exclusion Vitest discovers stale
    // copies with independently generated version metadata.
    exclude: [...configDefaults.exclude, "**/.kiro/**"],
    // Seed isolated, writable clai storage roots for every test file before
    // its modules load, so no test writes to (or races on) the developer's
    // real home-directory config/data. See test/vitest.setup.ts and Phase 0
    // requirement V2-002.
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
