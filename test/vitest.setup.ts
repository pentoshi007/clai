import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


const root = mkdtempSync(join(tmpdir(), "clai-test-roots-"));

const defaultRoot: Record<string, string> = {
  CLAI_CONFIG_DIR: "config",
  CLAI_DATA_DIR: "data",
  CLAI_HISTORY_DIR: "history",
  CLAI_PLAN_DIR: "plans",
  CLAI_LOG_DIR: "logs",
  CLAI_ARTIFACT_DIR: "artifacts",
  CLAI_JOBS_DIR: "jobs",
  CLAI_MCP_HOME: "home",
  CLAI_SESSION_WORKSPACE_DIR: "clai",
};

for (const [key, sub] of Object.entries(defaultRoot)) {
  const baseKey = `CLAI_TEST_BASE_${key}`;
  const injected = process.env[baseKey] ?? process.env[key];
  if (process.env.CI && injected) {
    process.env[baseKey] = injected;
    mkdirSync(injected, { recursive: true });
    process.env[key] = mkdtempSync(join(injected, "vitest-"));
  } else {
    process.env[key] = join(root, sub);
  }
}
