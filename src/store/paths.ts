import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getDataDir(): string {
  const configured = envPath("CLAI_DATA_DIR");
  if (configured) return configured;
  const home = homedir();
  const workerId = process.env.VITEST_WORKER_ID?.trim();
  if (workerId) {
    const tempRoot = resolve(tmpdir());
    const resolvedHome = resolve(home);
    if (resolvedHome === tempRoot || resolvedHome.startsWith(`${tempRoot}${sep}`)) {
      return join(home, ".clai");
    }
    return join(tmpdir(), `clai-data-${workerId}`);
  }
  return join(home, ".clai");
}

export function getHistoryDir(): string {
  return envPath("CLAI_HISTORY_DIR") ?? getDataDir();
}

export function getPlanDir(): string {
  return envPath("CLAI_PLAN_DIR") ?? getDataDir();
}

export function getLogsDirRoot(): string {
  return envPath("CLAI_LOG_DIR") ?? join(getDataDir(), "logs");
}

export function getArtifactDir(): string {
  return envPath("CLAI_ARTIFACT_DIR") ?? join(getDataDir(), "outputs");
}

export function getJobsDir(): string {
  return envPath("CLAI_JOBS_DIR") ?? join(getDataDir(), "jobs");
}
