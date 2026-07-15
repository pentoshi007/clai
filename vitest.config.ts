import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Seed isolated, writable clai storage roots for every test file before
    // its modules load, so no test writes to (or races on) the developer's
    // real home-directory config/data. See test/vitest.setup.ts and Phase 0
    // requirement V2-002.
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
