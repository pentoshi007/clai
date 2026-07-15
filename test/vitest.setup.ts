import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-file isolated clai storage roots.
//
// `src/store/config.ts` builds its `Conf` store once, at module-import time,
// from `CLAI_CONFIG_DIR`. When a test does not inject its own root, the store
// falls back to the developer's real OS config directory. Multiple test files
// then read/write the SAME on-disk config file, and because Vitest runs files
// in parallel a write from one file can be observed (or clobbered) by another
// — a scheduling-dependent flake (e.g. `free-only` seeing `freeOnly` reset by
// a concurrent file).
//
// This setup file runs before each test module is imported, so it can seed a
// unique, writable root for every clai storage location. Tests that inject
// their own roots still override these (the `if (!process.env[key])` guard
// leaves an explicitly-set value untouched) and restore them afterwards. This
// realizes Phase 0 requirement V2-002: tests never write to real home dirs.
const root = mkdtempSync(join(tmpdir(), "clai-test-roots-"));

const defaultRoot: Record<string, string> = {
  CLAI_CONFIG_DIR: "config",
  CLAI_DATA_DIR: "data",
  CLAI_HISTORY_DIR: "history",
  CLAI_PLAN_DIR: "plans",
  CLAI_LOG_DIR: "logs",
  CLAI_ARTIFACT_DIR: "artifacts",
  CLAI_JOBS_DIR: "jobs",
};

for (const [key, sub] of Object.entries(defaultRoot)) {
  if (!process.env[key]) process.env[key] = join(root, sub);
}
