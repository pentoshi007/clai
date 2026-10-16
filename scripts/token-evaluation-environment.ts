import { join } from "node:path";
import type { EvaluationRoute } from "./token-evaluation-config.js";
import { getEnvVar } from "../src/llm/provider.js";

export interface EvaluationCredential {
  readonly value: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: number | undefined;
}

export async function resolveEvaluationCredential(route: EvaluationRoute): Promise<EvaluationCredential | undefined> {
  if (route.provider === "ollama" || route.auth === "none") return undefined;
  if (route.auth !== "stored") {
    const variable = getEnvVar(route.provider);
    const value = variable ? process.env[variable]?.trim() : undefined;
    if (!value) throw new Error(`Explicit environment credentials required for ${route.provider}; stored credentials are not used`);
    return { value };
  }
  const { getProviderKeys } = await import("../src/store/keys.js");
  const slots = await getProviderKeys(route.provider);
  for (let offset = 0; offset < slots.keys.length; offset += 1) {
    const slot = slots.keys[(slots.activeIndex + offset) % slots.keys.length]!;
    if (!slot.disabled && slot.value) return { value: slot.value, refreshToken: slot.refreshToken, expiresAt: slot.expiresAt };
  }
  throw new Error(`No enabled stored credential for explicitly selected ${route.provider}`);
}

export function evaluationEnvironment(route: EvaluationRoute, workRoot: string, inherited: NodeJS.ProcessEnv, credential?: EvaluationCredential): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TERM"]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  const home = join(workRoot, ".evaluation", "home");
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(workRoot, ".evaluation", "tmp"), TMP: join(workRoot, ".evaluation", "tmp"), TEMP: join(workRoot, ".evaluation", "tmp"),
    CLAI_DISABLE_KEYCHAIN: "1", NO_COLOR: "1" });
  for (const [key, directory] of Object.entries({ CLAI_CONFIG_DIR: "config", CLAI_DATA_DIR: "data", CLAI_HISTORY_DIR: "history", CLAI_PLAN_DIR: "plans",
    CLAI_LOG_DIR: "logs", CLAI_ARTIFACT_DIR: "artifacts", CLAI_JOBS_DIR: "jobs", CLAI_SESSION_WORKSPACE_DIR: "scratch", CLAI_MCP_HOME: "home", CLAI_SCOPE_DIR: "scopes" })) {
    env[key] = join(workRoot, ".evaluation", directory);
  }
  const variable = getEnvVar(route.provider);
  if (credential) {
    if (!variable) throw new Error("Selected provider has no explicit environment credential transport");
    env[variable] = credential.value;
    if (credential.refreshToken) env.CLAI_EVALUATION_REFRESH_TOKEN = credential.refreshToken;
    if (credential.expiresAt !== undefined) env.CLAI_EVALUATION_EXPIRES_AT = String(credential.expiresAt);
  }
  if (route.provider === "ollama") env.OLLAMA_HOST = route.endpoint;
  return env;
}
