import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

const keys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
] as const;

export function useIsolatedHistory(prefix: string): { readonly dir: () => string } {
  let dir = "";
  let saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    dir = mkdtempSync(join(tmpdir(), prefix));
    process.env.CLAI_DATA_DIR = dir;
    process.env.CLAI_HISTORY_DIR = dir;
    process.env.CLAI_CONFIG_DIR = join(dir, "config");
    process.env.CLAI_PLAN_DIR = join(dir, "plans");
    process.env.CLAI_LOG_DIR = join(dir, "logs");
    process.env.CLAI_ARTIFACT_DIR = join(dir, "artifacts");
    process.env.CLAI_JOBS_DIR = join(dir, "jobs");
    vi.resetModules();
  });
  afterEach(async () => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { dir: () => dir };
}
