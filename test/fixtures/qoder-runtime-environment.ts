import { join } from "node:path";

export function qoderRuntimeEnvironment(sandbox: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("QODER_") || key.startsWith("CLAI_TEST_BASE_")) delete env[key];
  const home = join(sandbox, "home");
  return {
    ...env, HOME: home, CLAI_QODER_FIXTURE_HOME: home,
    QODER_CONFIG_DIR: join(sandbox, "qoder"), CLAI_CONFIG_DIR: join(sandbox, "config"),
    CLAI_DATA_DIR: join(sandbox, "data"), CLAI_HISTORY_DIR: join(sandbox, "history"),
    CLAI_PLAN_DIR: join(sandbox, "plans"), CLAI_LOG_DIR: join(sandbox, "logs"),
    CLAI_ARTIFACT_DIR: join(sandbox, "artifacts"), CLAI_JOBS_DIR: join(sandbox, "jobs"),
    CLAI_MCP_HOME: home, CLAI_SESSION_WORKSPACE_DIR: join(sandbox, "workspace"),
    CLAI_SESSION_MODEL_DIR: join(sandbox, "models"), CLAI_DISABLE_KEYCHAIN: "1",
    CLAI_OFFLINE: "1", CLAI_NO_UPDATE_CHECK: "1", CLAI_NO_BROWSER: "1",
    DISPLAY: "", WAYLAND_DISPLAY: "", BROWSER: "none",
  };
}
